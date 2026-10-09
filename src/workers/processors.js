import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { PushOutcomeKind } from "../lib/fcm-outcomes.js";
import { Customer, ExportJob, Message, OutboxEvent, PaymentIntent, PaymentLink, Scheme, Tenant, WebhookEvent } from "../models/index.js";
import { whatsappProvider } from "../integrations/whatsapp.provider.js";
import { updateDelivery } from "../services/messaging.service.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { storageProvider } from "../integrations/storage.provider.js";
import { unseal } from "../lib/crypto.js";
import { AppError } from "../lib/app-error.js";
import { AlertType } from "../constants/enums.js";
import { upsertOperationalAlert } from "../lib/operational-alert.js";
import { PhonePeCallbackClass } from "../lib/phonepe-callback-classification.js";
import { normalizePhonePeWebhookEvent } from "../lib/phonepe-webhook-payload.js";
import { isPhonePeRefundCallback } from "../integrations/phonepe.provider.js";
import { validatePhonePeCompletedIdentifiers } from "../lib/phonepe-completed-identifiers.js";
import { upsertGatewayWebhookInvalidCompletedAlert } from "../lib/gateway-webhook-invalid-completed.js";
import { finalizeGatewaySuccess } from "../services/finalize-gateway-success.service.js";
import { applyTerminalGatewayFailure } from "../services/gateway-terminal-failure.service.js";
import { buildReportExportRows, exportReportKey, isRawExportType } from "../lib/report-export.js";
import { exportScopeForWorker } from "../lib/export-authority.js";
import PDFDocument from "pdfkit";
import {
  recordExportRun,
  recordMessageStatusTransition,
  recordPhonePeWebhookOutOfOrder,
} from "../lib/ops-metrics.js";

const csvCell = (value) => {
  let text = String(typeof value === "object" && value !== null ? JSON.stringify(value) : value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

const TERMINAL_MESSAGE_STATUSES = new Set(["DELIVERED", "SENT", "READ"]);

export async function processMessage(job) {
  const message = await Message.findById(job.data.messageId);
  if (!message || TERMINAL_MESSAGE_STATUSES.has(message.status)) return;
  try {
    if (message.channel === "PUSH") {
      const { pushProvider } = await import("../integrations/push.provider.js");
      const { buildPushPayload } = await import("../lib/push-payload.js");
      const { Customer, Payment, Scheme } = await import("../models/index.js");
      const {
        resolvePushDevicesForCustomer,
        invalidateDeviceRegistrations,
        markDeviceSuccess,
        markDeviceFailure,
      } = await import("../services/device-registration.service.js");
      const {
        ensurePushDeliveries,
        listDeliveriesToSend,
        claimDeliveriesForProcessing,
        applyPushOutcomes,
        reclaimStaleProcessingDeliveries,
        releaseDeferredDeliveries,
        releaseOwnedClaimsOnError,
        summarizePushDeliveries,
        casFinalizePushMessageFromSummary,
        casFailPushMessageNoDevices,
        PushDeliveryApplyResult,
      } = await import("../services/push-delivery.service.js");
      const { PushDeviceDeliveryStatus } = await import("../constants/enums.js");
      const { FcmSendDeferredError } = await import("../lib/fcm-push-errors.js");
      const { retryDelayMs } = await import("../integrations/push.provider.js");
      const { DelayedError } = await import("bullmq");
      const [customer, scheme, payment, tenant] = await Promise.all([
        Customer.findOne({ _id: message.customerId, tenantId: message.tenantId })
          .select("+fcmTokens")
          .lean(),
        message.schemeId
          ? Scheme.findById(message.schemeId).lean()
          : null,
        message.templateParams?.paymentId
          ? Payment.findById(message.templateParams.paymentId).lean()
          : null,
        Tenant.findById(message.tenantId).select("name displayName +integrationSecrets").lean(),
      ]);
      const devices = await resolvePushDevicesForCustomer({
        tenantId: message.tenantId,
        customerId: message.customerId,
        legacyFcmTokens: customer?.fcmTokens,
      });
      await ensurePushDeliveries({
        tenantId: message.tenantId,
        messageId: message._id,
        devices,
      });
      await reclaimStaleProcessingDeliveries({
        tenantId: message.tenantId,
        messageId: message._id,
      });
      const pendingDeliveries = await listDeliveriesToSend(message._id, message.tenantId);
      const pendingKeys = new Set(pendingDeliveries.map((row) => row.deviceRegistrationId));
      const devicesToSend = devices.filter((device) => {
        const key = device.deviceRegistrationId ?? `legacy:${device.tokenHash}`;
        return pendingKeys.has(key);
      }).map((device) => {
        const pending = pendingDeliveries.find(
          (row) => row.deviceRegistrationId === (device.deviceRegistrationId ?? `legacy:${device.tokenHash}`),
        );
        return {
          ...device,
          _deliveryAttempt: (pending?.attemptCount ?? 0) + 1,
        };
      });
      const payload = buildPushPayload({ message, scheme, payment, tenant });
      const { resolveFcmImageUrl } = await import("../services/upload.service.js");
      const imageUrl = message.templateParams?.pushImageUrl
        ?? await resolveFcmImageUrl(message.templateParams?.imageUploadId);
      if (!devicesToSend.length) {
        if (TERMINAL_MESSAGE_STATUSES.has(message.status)) return;
        const summaryBeforeSend = await summarizePushDeliveries({
          tenantId: message.tenantId,
          messageId: message._id,
        });
        if (summaryBeforeSend.processingActive > 0) return;
        const pendingStill = await listDeliveriesToSend(message._id, message.tenantId);
        if (pendingStill.length) return;
        if (!devices.length) {
          const failResult = await casFailPushMessageNoDevices({
            tenantId: message.tenantId,
            messageId: message._id,
          });
          if (failResult.applied) recordMessageStatusTransition("FAILED");
        }
        return;
      }
      const registrationIds = devicesToSend.map(
        (d) => d.deviceRegistrationId ?? `legacy:${d.tokenHash}`,
      );
      const claimed = await claimDeliveriesForProcessing({
        tenantId: message.tenantId,
        messageId: message._id,
        deviceRegistrationIds: registrationIds,
      });
      const claimByRegistration = new Map(
        claimed.map((row) => [row.deviceRegistrationId, row.claimToken]),
      );
      const sendList = devicesToSend.filter((device) => {
        const key = device.deviceRegistrationId ?? `legacy:${device.tokenHash}`;
        return claimByRegistration.has(key);
      });
      const ownedClaims = claimed.map((row) => ({
        deviceRegistrationId: row.deviceRegistrationId,
        claimToken: row.claimToken,
      }));
      if (!sendList.length) {
        const activeSummary = await summarizePushDeliveries({
          tenantId: message.tenantId,
          messageId: message._id,
        });
        if (activeSummary.processingActive > 0) return;
        return;
      }

      let result;
      try {
        result = await pushProvider.send({
          tenant,
          tenantId: message.tenantId,
          devices: sendList,
          title: payload.title,
          body: payload.body,
          data: payload.data,
          imageUrl: imageUrl ?? undefined,
          messageType: message.type,
          collapseKey: message._id,
        });
      } catch (error) {
        if (error instanceof FcmSendDeferredError) {
          await releaseDeferredDeliveries({
            tenantId: message.tenantId,
            messageId: message._id,
            claims: ownedClaims,
          });
          const delayMs = error.retryAfterMs;
          await job.moveToDelayed(Date.now() + delayMs, job.token);
          throw new DelayedError();
        }
        await releaseOwnedClaimsOnError({
          tenantId: message.tenantId,
          messageId: message._id,
          claims: ownedClaims,
        });
        throw error;
      }
      const applyResults = await applyPushOutcomes({
        tenantId: message.tenantId,
        messageId: message._id,
        outcomes: result.outcomes.map((row) => ({
          ...row,
          claimToken: claimByRegistration.get(
            row.deviceRegistrationId ?? (row.tokenHash ? `legacy:${row.tokenHash}` : ""),
          ),
        })),
      });
      const applyByRegistration = new Map(
        applyResults
          .filter((row) => row.deviceRegistrationId)
          .map((row) => [row.deviceRegistrationId, row]),
      );
      const applied = applyResults.filter(
        (row) => row.result === PushDeliveryApplyResult.APPLIED,
      );
      const successIds = applied
        .filter((row) => row.resultingStatus === PushDeviceDeliveryStatus.SUCCEEDED)
        .map((row) => row.deviceRegistrationId)
        .filter(Boolean);
      const failedIds = applied
        .filter((row) => row.resultingStatus !== PushDeviceDeliveryStatus.SUCCEEDED
          && row.resultingStatus !== PushDeviceDeliveryStatus.RETRYABLE_FAILED)
        .map((row) => row.deviceRegistrationId)
        .filter(Boolean);
      await markDeviceSuccess(message.tenantId, successIds);
      await markDeviceFailure(message.tenantId, failedIds);

      const invalidFromApplied = [];
      const appliedInvalidPlainTokens = new Set();
      for (let i = 0; i < result.outcomes.length; i += 1) {
        const outcome = result.outcomes[i];
        const regKey = outcome.deviceRegistrationId
          ?? (outcome.tokenHash ? `legacy:${outcome.tokenHash}` : null);
        const applyRow = applyByRegistration.get(regKey);
        if (applyRow?.result !== PushDeliveryApplyResult.APPLIED) continue;
        if (outcome.kind !== PushOutcomeKind.PERMANENT_INVALID_TOKEN) continue;
        if (outcome.token) appliedInvalidPlainTokens.add(outcome.token);
        const invalidEntry = result.invalidRegistrationIds?.find(
          (row) => (row.id ?? row) && (row.tokenHash === outcome.tokenHash || row.id === outcome.deviceRegistrationId),
        );
        if (invalidEntry) {
          invalidFromApplied.push({
            id: invalidEntry.id ?? invalidEntry,
            expectedTokenHash: invalidEntry.tokenHash ?? outcome.tokenHash,
            registrationVersion: invalidEntry.registrationVersion,
          });
        } else if (outcome.deviceRegistrationId) {
          invalidFromApplied.push({
            id: outcome.deviceRegistrationId,
            expectedTokenHash: outcome.tokenHash,
          });
        }
      }
      if (invalidFromApplied.length) {
        await invalidateDeviceRegistrations(
          message.tenantId,
          invalidFromApplied,
          "FCM_UNREGISTERED",
        );
        if (customer?._id && appliedInvalidPlainTokens.size) {
          const { decryptFcmTokens } = await import("../lib/fcm-tokens.js");
          const sealedInvalid = decryptFcmTokens(customer.fcmTokens ?? [])
            .filter((row) => appliedInvalidPlainTokens.has(row.token))
            .map((row) => row.tokenHash);
          if (sealedInvalid.length) {
            await Customer.updateOne(
              { _id: customer._id, tenantId: message.tenantId },
              { $pull: { fcmTokens: { tokenHash: { $in: sealedInvalid } } } },
            );
          }
        }
      }

      const stillRetryable = await listDeliveriesToSend(message._id, message.tenantId);
      if (stillRetryable.length) {
        const retryableOutcome = result.outcomes.find(
          (row) => row.kind === PushOutcomeKind.TRANSIENT,
        );
        const delayMs = retryDelayMs(
          message.attemptCount ?? 1,
          env.FCM_RETRY_BASE_MS ?? 500,
          retryableOutcome?.retryAfterMs ?? null,
        );
        await job.moveToDelayed(Date.now() + delayMs, job.token);
        throw new DelayedError();
      }

      const deliverySummary = await summarizePushDeliveries({
        tenantId: message.tenantId,
        messageId: message._id,
      });
      if (deliverySummary.processingActive > 0) return;
      if (deliverySummary.queued > 0 || deliverySummary.retryableFailed > 0) return;

      let providerMessageId;
      for (const outcome of result.outcomes) {
        const regKey = outcome.deviceRegistrationId
          ?? (outcome.tokenHash ? `legacy:${outcome.tokenHash}` : null);
        const applyRow = applyByRegistration.get(regKey);
        if (applyRow?.result === PushDeliveryApplyResult.APPLIED && outcome.providerMessageId) {
          providerMessageId = outcome.providerMessageId;
          break;
        }
      }
      const finalize = await casFinalizePushMessageFromSummary({
        tenantId: message.tenantId,
        messageId: message._id,
        deliverySummary,
        providerMessageId,
      });
      if (finalize.applied && finalize.status) {
        recordMessageStatusTransition(finalize.status);
      }
      return;
    }
    const templateName = message.templateKey === "PAYMENT_SUCCESS_MEDIA" && !message.templateParams?.passbookImageUrl ? "PAYMENT_SUCCESS_TEXT_FALLBACK" : message.templateKey;
    const tenant = await Tenant.findById(message.tenantId).select("+integrationSecrets").lean();
    const config = tenant?.integrationSecrets?.whatsapp;
    const credentials = config ? { phoneNumberId: config.phoneNumberId, accessToken: config.accessToken ? unseal(config.accessToken) : undefined } : {};
    const result = await whatsappProvider.sendTemplate({ to: message.templateParams?.mobile, templateName, components: templateName === "PAYMENT_SUCCESS_TEXT_FALLBACK" ? message.templateParams?.textComponents : message.templateParams?.components, credentials });
    message.status = result.status;
    if (env.PROVIDER_MODE === "mock" && message.status === "SENT") {
      message.status = "DELIVERED";
      message.deliveredAt = new Date();
    }
    message.templateKey = templateName;
    message.providerMessageId = result.providerMessageId;
    message.lastAttemptAt = new Date();
    message.attemptCount = (message.attemptCount ?? 0) + 1;
    await message.save();
    recordMessageStatusTransition(message.status);
  } catch (error) {
    if (error?.name === "DelayedError") throw error;
    if (!TERMINAL_MESSAGE_STATUSES.has(message.status)) {
      message.status = "FAILED";
      message.failureMessage = error.message;
      message.failedAt = new Date();
      message.attemptCount = (message.attemptCount ?? 0) + 1;
      await message.save();
      recordMessageStatusTransition("FAILED");
    }
    throw error;
  }
}
export async function processWebhook(job) {
  const eventId = job.data.webhookEventId;
  const existing = await WebhookEvent.findById(eventId).lean();
  if (!existing || existing.status === "COMPLETED" || existing.status === "UNSUPPORTED") return;
  const { claimWebhookForProcessing, finalizeWebhookStorage } = await import("../services/webhook-event.service.js");
  const { incrementWebhookMetric, observeWebhookProcessingMs, WebhookMetric } = await import("../lib/webhook-metrics.js");
  const leaseOwner = String(job.id ?? job.name ?? "worker");
  const event = await claimWebhookForProcessing(eventId, leaseOwner);
  if (!event) return;
  const started = Date.now();
  try {
    if (event.provider === "PHONEPE") {
      const normalized = normalizePhonePeWebhookEvent(event.payload);
      const { reference, payload, transactionId } = normalized;
      let phonePeHandled = false;
      if (normalized.refund || isPhonePeRefundCallback(event.payload?.type)) {
        phonePeHandled = true;
        const { isEcommercePhonePeRefundPayload } = await import("../lib/ecommerce-payment-reference.js");
        if (isEcommercePhonePeRefundPayload(payload)) {
          const { processEcommercePhonePeRefundWebhook } = await import(
            "../services/ecommerce-payment-exception-refund.service.js"
          );
          await processEcommercePhonePeRefundWebhook({
            tenantId: event.tenantId,
            type: event.payload?.type,
            payload,
            providerEventId: event.providerEventId,
          });
        } else {
          const { processPhonePeRefundWebhook } = await import("../services/phonepe-refund.service.js");
          await processPhonePeRefundWebhook({
            tenantId: event.tenantId,
            type: event.payload?.type,
            payload,
            providerEventId: event.providerEventId,
          });
        }
      } else if (
        normalized.completed
        || normalized.classification === PhonePeCallbackClass.ORDER_COMPLETED
      ) {
        phonePeHandled = true;
        const { processEcommercePhonePeWebhook } = await import("../services/ecommerce-payment-finalize.service.js");
        const { isEcommercePaymentMerchantOrderId } = await import("../lib/ecommerce-payment-reference.js");
        if (reference && isEcommercePaymentMerchantOrderId(reference)) {
          await processEcommercePhonePeWebhook({
            tenantId: event.tenantId,
            normalized,
            webhookEventId: event._id,
          });
        } else {
        const intent = reference
          ? await PaymentIntent.findOne({
            tenantId: event.tenantId,
            $or: [{ _id: reference }, { providerOrderId: reference }],
          })
          : null;
        const link = !intent && reference
          ? await PaymentLink.findOne({ tenantId: event.tenantId, _id: reference })
          : null;
        const verified = validatePhonePeCompletedIdentifiers({
          merchantOrderId: reference,
          normalized: {
            transactionId,
            amount: normalized.amount,
          },
        });
        if (!verified.ok) {
          await upsertGatewayWebhookInvalidCompletedAlert({
            tenantId: event.tenantId,
            entityId: reference ?? event._id,
            code: verified.code,
            reference,
            webhookEventId: event._id,
          });
        } else {
          const finalized = await finalizeGatewaySuccess({
            tenantId: event.tenantId,
            reference,
            transactionId: verified.transactionId,
            amountPaise: verified.amountPaise,
            providerPayload: payload,
            webhookEventId: event._id,
            intent,
            link,
          });
          if (
            finalized.outcome !== "SUCCESS"
            && finalized.outcome !== "ALREADY_SUCCESS"
            && !intent
            && !link
          ) {
            await upsertOperationalAlert({
              tenantId: event.tenantId,
              type: AlertType.GATEWAY_WEBHOOK_UNMATCHED,
              entityId: reference ?? event._id,
              title: "Unmatched gateway webhook",
              message: "A completed gateway callback did not match any payment intent or link.",
              metadata: {
                provider: event.provider,
                reference,
              },
            });
          }
        }
        }
      } else if (normalized.attemptFailed) {
        phonePeHandled = true;
        logger.info(
          {
            type: normalized.type,
            reference,
            transactionId,
            classification: normalized.classification,
          },
          "PhonePe transaction attempt failed — order remains non-terminal",
        );
      } else if (
        normalized.failed
        || normalized.classification === PhonePeCallbackClass.ORDER_TERMINAL_FAILED
      ) {
        phonePeHandled = true;
        const { processEcommercePhonePeWebhook } = await import("../services/ecommerce-payment-finalize.service.js");
        const { isEcommercePaymentMerchantOrderId } = await import("../lib/ecommerce-payment-reference.js");
        if (reference && isEcommercePaymentMerchantOrderId(reference)) {
          await processEcommercePhonePeWebhook({
            tenantId: event.tenantId,
            normalized,
            webhookEventId: event._id,
          });
        } else {
        const result = await applyTerminalGatewayFailure({
          tenantId: event.tenantId,
          transactionId,
          reference,
          providerPayload: payload,
        });
        if (result.skipped && result.reason === "ALREADY_SUCCESS") {
          recordPhonePeWebhookOutOfOrder();
          logger.info(
            { reference, transactionId, type: normalized.type },
            "Ignoring terminal PhonePe failure after payment already succeeded",
          );
        }
        }
      }
      if (!phonePeHandled) {
        const { finalizeUnsupportedPhonePeCallback } = await import("../services/phonepe-unsupported-callback.service.js");
        await finalizeUnsupportedPhonePeCallback({
          tenantId: event.tenantId,
          webhookEventId: event._id,
          providerEventId: event.providerEventId,
          type: event.payload?.type,
          payload,
        });
        await finalizeWebhookStorage(event._id);
        observeWebhookProcessingMs(Date.now() - started);
        return;
      }
    } else if (event.provider === "WHATSAPP") {
      const { persistWhatsAppInboundFromWebhook } = await import("../services/inbound-message.service.js");
      await persistWhatsAppInboundFromWebhook({
        tenantId: event.tenantId,
        webhookEventId: event._id,
        payload: event.payload,
      });
      const status = event.payload?.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
      if (status) await updateDelivery(status.id, status.status?.toUpperCase(), status.errors?.[0]);
    }
    const { JobStatus } = await import("../constants/enums.js");
    const completed = await WebhookEvent.findOneAndUpdate(
      {
        _id: event._id,
        status: { $nin: [JobStatus.UNSUPPORTED, JobStatus.COMPLETED] },
      },
      {
        $set: {
          status: JobStatus.COMPLETED,
          processedAt: new Date(),
          error: null,
        },
      },
      { new: true },
    );
    if (!completed) {
      observeWebhookProcessingMs(Date.now() - started);
      return;
    }
    await finalizeWebhookStorage(event._id);
    incrementWebhookMetric(WebhookMetric.PROCESSING_COMPLETED);
    observeWebhookProcessingMs(Date.now() - started);
  } catch (error) {
    event.status = job.attemptsMade >= 4 ? "DEAD_LETTER" : "FAILED";
    event.error = error.message;
    await event.save();
    if (event.status === "DEAD_LETTER") {
      incrementWebhookMetric(WebhookMetric.DEAD_LETTER);
      await upsertOperationalAlert({
        tenantId: event.tenantId,
        type: AlertType.WEBHOOK_FAILURE,
        entityId: event._id,
        title: "Webhook processing failed",
        message: error.message,
        metadata: { provider: event.provider },
      });
    } else {
      incrementWebhookMetric(WebhookMetric.PROCESSING_FAILED);
    }
    observeWebhookProcessingMs(Date.now() - started);
    throw error;
  }
}
export async function processOutbox(job) {
  const event = await OutboxEvent.findById(job.data.outboxEventId);
  if (!event || event.status === "COMPLETED") return;
  if (event.topic === "scheme.joined") {
    const customer = await Customer.findOne({
      _id: event.payload.customerId,
      tenantId: event.tenantId,
    }).select("mobile whatsappOptedOutAt").lean();
    const scheme = await Scheme.findOne({
      _id: event.payload.schemeId,
      tenantId: event.tenantId,
    }).select("enrollmentNumber planSnapshot").lean();
    const exists = await Message.exists({
      tenantId: event.tenantId,
      schemeId: event.payload.schemeId,
      type: "SCHEME_JOINED",
    });
    if (customer && scheme && !exists) {
      const { queueCustomerNotification } = await import("../services/customer-notification.service.js");
      await queueCustomerNotification({
        tenantId: event.tenantId,
        branchId: event.payload.branchId,
        customerId: event.payload.customerId,
        schemeId: event.payload.schemeId,
        type: "SCHEME_JOINED",
        templateParams: {
          mobile: customer.mobile,
          enrollmentNumber: scheme.enrollmentNumber,
          schemeName: scheme.planSnapshot?.displayName ?? scheme.planSnapshot?.name,
          event: "ACTIVATION",
        },
      });
    }
  } else if (event.topic === "payment.succeeded") {
    const customer = await Customer.findOne({ _id: event.payload.customerId, tenantId: event.tenantId }).select("mobile whatsappOptedOutAt").lean();
    const exists = await Message.exists({ tenantId: event.tenantId, type: "PAYMENT_SUCCESS", "templateParams.paymentId": event.payload.paymentId });
    if (customer && !exists) {
      const { queueCustomerNotification } = await import("../services/customer-notification.service.js");
      const { paymentSuccessTemplateKeyForTenant } = await import("../services/messaging.service.js");
      const paymentSuccessTemplateKey = await paymentSuccessTemplateKeyForTenant(event.tenantId);
      if (!customer.whatsappOptedOutAt) {
        await queueCustomerNotification({
          tenantId: event.tenantId,
          branchId: event.payload.branchId,
          customerId: event.payload.customerId,
          schemeId: event.payload.schemeId,
          type: "PAYMENT_SUCCESS",
          templateKey: paymentSuccessTemplateKey,
          templateParams: {
            paymentId: event.payload.paymentId,
            mobile: customer.mobile,
            passbookImageUrl: null,
            textComponents: [],
          },
        });
      } else {
        await queueCustomerNotification({
          tenantId: event.tenantId,
          branchId: event.payload.branchId,
          customerId: event.payload.customerId,
          schemeId: event.payload.schemeId,
          type: "PAYMENT_SUCCESS",
          pushOnly: true,
          templateParams: {
            paymentId: event.payload.paymentId,
            mobile: customer.mobile,
          },
        });
      }
    }
  } else if (event.topic === "payment.gateway.failed") {
    // Durable signal for gateway terminal failure; no customer fan-out.
  } else if (event.topic === "scheme.flex_policy.closed") {
    const customer = await Customer.findOne({
      _id: event.payload.customerId,
      tenantId: event.tenantId,
    }).select("mobile whatsappOptedOutAt").lean();
    const scheme = await Scheme.findOne({
      _id: event.payload.schemeId,
      tenantId: event.tenantId,
    }).select("enrollmentNumber planSnapshot").lean();
    const exists = await Message.exists({
      tenantId: event.tenantId,
      schemeId: event.payload.schemeId,
      type: "SCHEME_CLOSED",
    });
    if (customer && scheme && !exists) {
      const { queueCustomerNotification } = await import("../services/customer-notification.service.js");
      await queueCustomerNotification({
        tenantId: event.tenantId,
        branchId: event.payload.branchId,
        customerId: event.payload.customerId,
        schemeId: event.payload.schemeId,
        type: "SCHEME_CLOSED",
        templateParams: {
          mobile: customer.mobile,
          enrollmentNumber: scheme.enrollmentNumber,
          schemeName: scheme.planSnapshot?.displayName ?? scheme.planSnapshot?.name,
          event: "FLEX_POLICY_CLOSED",
          closeReason: event.payload.closeReason,
        },
      });
    }
  } else if (event.topic === "message.send") {
    const messageId = event.payload?.messageId ?? event.key;
    const exists = messageId
      ? await Message.exists({ _id: messageId, tenantId: event.tenantId })
      : false;
    if (!exists) {
      event.status = "COMPLETED";
      event.processedAt = new Date();
      event.error = "LEGACY_MESSAGE_SEND_ORPHAN";
      await event.save();
      return;
    }
    event.error = null;
  } else if (event.topic !== "message.send") {
    event.status = "DEAD_LETTER";
    event.error = `Unhandled outbox topic: ${event.topic}`;
    await event.save();
    await upsertOperationalAlert({
      tenantId: event.tenantId,
      type: AlertType.SYSTEM_ERROR,
      entityId: String(event._id),
      title: "Unknown outbox topic",
      message: event.error,
      entityType: "OUTBOX_EVENT",
      metadata: { topic: event.topic },
    });
    logger.error({ outboxEventId: event._id, topic: event.topic }, "Unknown outbox topic moved to dead letter");
    return;
  }
  event.status = "COMPLETED";
  event.processedAt = new Date();
  await event.save();
}
async function writeExportCsv(tempFile, headers, rows) {
  const output = createWriteStream(tempFile, { encoding: "utf8" });
  output.write(`${headers.map(csvCell).join(",")}\n`);
  for (const row of rows) {
    const line = row.map(csvCell).join(",");
    if (!output.write(`${line}\n`)) await once(output, "drain");
  }
  output.end();
  await once(output, "finish");
}

async function writeRawModelExport(record, tempFile) {
  const models = await import("../models/index.js");
  const model = record.type === "AUDIT"
    ? models.AuditEvent
    : record.type === "CUSTOMER"
      ? models.Customer
      : models.Scheme;
  const dateField = record.type === "AUDIT" ? "occurredAt" : "createdAt";
  const workerScope = exportScopeForWorker(record);
  const query = { tenantId: record.tenantId };
  if (workerScope.branchId) query.branchId = workerScope.branchId;
  for (const key of ["status", "customerId", "schemeId", "mode"]) {
    if (record.filters?.[key]) query[key] = record.filters[key];
  }
  if (record.filters?.from || record.filters?.to) {
    query[dateField] = {
      ...(record.filters.from ? { $gte: new Date(`${record.filters.from}T00:00:00+05:30`) } : {}),
      ...(record.filters.to ? { $lte: new Date(`${record.filters.to}T23:59:59.999+05:30`) } : {}),
    };
  }
  const output = createWriteStream(tempFile, { encoding: "utf8" });
  let columns;
  let rowCount = 0;
  for await (const row of model.find(query).lean().cursor()) {
    if (!columns) {
      columns = Object.keys(row);
      output.write(`${columns.map(csvCell).join(",")}\n`);
    }
    const line = columns.map((key) => csvCell(row[key])).join(",");
    if (!output.write(`${line}\n`)) await once(output, "drain");
    rowCount += 1;
  }
  if (!columns) output.write("\n");
  output.end();
  await once(output, "finish");
  return rowCount;
}

async function writePdf(tempFile, title, headers, rows) {
  const output = createWriteStream(tempFile);
  const document = new PDFDocument({ margin: 36, size: "A4", layout: headers.length > 6 ? "landscape" : "portrait" });
  document.pipe(output);
  document.fontSize(16).text(title);
  document.moveDown(0.5).fontSize(8).fillColor("#444444").text(headers.join(" | "));
  document.moveDown(0.5).fillColor("#111111");
  for (const row of rows) {
    if (document.y > document.page.height - 48) document.addPage();
    document.text(row.map((value) => String(value ?? "")).join(" | "), { width: document.page.width - 72 });
  }
  document.end();
  await once(output, "finish");
}

async function writeRawModelPdf(record, tempFile) {
  const { maxExportRows } = await import("../lib/report-limits.js");
  const models = await import("../models/index.js");
  const model = record.type === "AUDIT" ? models.AuditEvent : record.type === "CUSTOMER" ? models.Customer : models.Scheme;
  const dateField = record.type === "AUDIT" ? "occurredAt" : "createdAt";
  const workerScope = exportScopeForWorker(record);
  const query = { tenantId: record.tenantId };
  if (workerScope.branchId) query.branchId = workerScope.branchId;
  for (const key of ["status", "customerId", "schemeId", "mode"]) {
    if (record.filters?.[key]) query[key] = record.filters[key];
  }
  if (record.filters?.from || record.filters?.to) {
    query[dateField] = {
      ...(record.filters.from ? { $gte: new Date(`${record.filters.from}T00:00:00+05:30`) } : {}),
      ...(record.filters.to ? { $lte: new Date(`${record.filters.to}T23:59:59.999+05:30`) } : {}),
    };
  }
  const max = maxExportRows();
  let rowCount = 0;
  let headers = null;
  const pdfRows = [];
  for await (const row of model.find(query).lean().cursor()) {
    if (!headers) headers = Object.keys(row);
    pdfRows.push(headers.map((key) => (typeof row[key] === "object" ? JSON.stringify(row[key]) : row[key])));
    rowCount += 1;
    if (rowCount > max) {
      throw new AppError(
        "EXPORT_TOO_LARGE",
        "Export exceeds the maximum allowed row count.",
        422,
      );
    }
  }
  await writePdf(tempFile, `${record.type} export`, headers ?? ["No records"], pdfRows);
  return rowCount;
}

export async function processExport(job) {
  const record = await ExportJob.findById(job.data.exportId);
  if (!record) return;
  record.status = "PROCESSING";
  await record.save();
  const started = Date.now();
  const {
    assertExportRowCount,
    maxExportBytes,
    maxExportRuntimeMs,
  } = await import("../lib/report-limits.js");
  const { exportDownloadExpiresAt } = await import("../services/export-expiry.service.js");
  try {
    const directory = path.resolve("exports");
    await fs.mkdir(directory, { recursive: true });
    const format = record.filters?.format ?? "CSV";
    const extension = format === "PDF" ? "pdf" : "csv";
    const tempFile = path.join(directory, `${record._id}.${extension}`);
    let rowCount = 0;

    if (isRawExportType(record.type)) {
      rowCount = format === "PDF" ? await writeRawModelPdf(record, tempFile) : await writeRawModelExport(record, tempFile);
    } else if (exportReportKey(record.type)) {
      const built = await buildReportExportRows(record);
      if (format === "PDF") await writePdf(tempFile, `${record.type} report`, built.headers, built.rows);
      else await writeExportCsv(tempFile, built.headers, built.rows);
      rowCount = built.rows.length;
    } else {
      throw new AppError(
        "EXPORT_TYPE_NOT_SUPPORTED",
        `Export type ${record.type} is not supported yet.`,
        501,
        { type: record.type },
      );
    }

    assertExportRowCount(rowCount);
    if (Date.now() - started > maxExportRuntimeMs()) {
      throw new AppError(
        "EXPORT_RUNTIME_EXCEEDED",
        "Export generation exceeded the allowed runtime.",
        422,
      );
    }
    const fileStat = await fs.stat(tempFile);
    if (fileStat.size > maxExportBytes()) {
      throw new AppError(
        "EXPORT_TOO_LARGE",
        "Export file exceeds the maximum allowed size.",
        422,
      );
    }
    const objectKey = `exports/${record.tenantId}/${record._id}.${extension}`;
    const body = await fs.readFile(tempFile);
    await storageProvider.uploadFile({ objectKey, body, contentType: format === "PDF" ? "application/pdf" : "text/csv; charset=utf-8" });
    await fs.unlink(tempFile).catch(() => {});
    record.objectKey = objectKey;
    record.rowCount = rowCount;
    record.status = "READY";
    record.downloadExpiresAt = exportDownloadExpiresAt();
    await record.save();
    recordExportRun({
      success: true,
      rowCount,
      bytes: fileStat.size,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    record.status = "FAILED";
    record.error = error.message?.slice(0, 500) ?? "Export failed";
    await record.save();
    recordExportRun({ success: false, durationMs: Date.now() - started });
    throw error;
  }
}
export async function processScheduler(job) {
  const now = new Date();
  const today = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const {
    runMaturityMaintenance,
    runDueInstallmentMaintenance,
    runOverdueMaintenance,
    runDefaultingMaintenance,
    runExpireFlexibleCapacityMaintenance,
    runFlexibleLockMaintenance,
    runGrievanceAutoCloseMaintenance,
  } = await import("../services/scheme-maintenance.service.js");

  if (job.name === "maturity") await runMaturityMaintenance({ today });
  if (job.name === "due-installments") await runDueInstallmentMaintenance({ today });
  if (job.name === "overdue") await runOverdueMaintenance({ today });
  if (job.name === "payment-reminders") {
    const { runReminderScheduler } = await import("../services/reminder-scheduler.service.js");
    await runReminderScheduler(now);
  }
  if (job.name === "expire-flexible-capacity") {
    await runExpireFlexibleCapacityMaintenance({ today });
  }
  if (job.name === "defaulting") await runDefaultingMaintenance();
  if (job.name === "apply-flexible-locks") await runFlexibleLockMaintenance({ today });
  if (job.name === "grievance-auto-close") await runGrievanceAutoCloseMaintenance(now);
  if (job.name === "gateway-settlement") {
    const { runDailyGatewaySettlementBatch } = await import("../services/gateway-settlement.service.js");
    await runDailyGatewaySettlementBatch();
  }
}

export async function processPaymentsMaintenance(job) {
  const now = new Date();
  if (job.name === "expire-payments") {
    const { runPaymentExpiry } = await import("../services/payment-expiry.service.js");
    await runPaymentExpiry(now);
  }
  if (job.name === "phonepe-reconcile") {
    const { runPhonePeReconciliation } = await import("../services/phonepe-reconcile.service.js");
    await runPhonePeReconciliation(String(job.id ?? "worker"));
  }
}

export async function processMaintenance(job) {
  const now = new Date();
  if (job.name === "push-broadcast-fanout") {
    const { processPushBroadcastFanout } = await import("../services/push-broadcast.service.js");
    await processPushBroadcastFanout(job.data.broadcastId, String(job.id ?? "worker"));
  }
  if (job.name === "push-broadcast-recover") {
    const { processPushBroadcastFanoutRecovery } = await import("../services/push-broadcast.service.js");
    await processPushBroadcastFanoutRecovery();
  }
  if (job.name === "webhook-reclaim") {
    const { reclaimExpiredWebhookLeases } = await import("../services/webhook-event.service.js");
    await reclaimExpiredWebhookLeases();
  }
  if (job.name === "dispatch-reclaim") {
    const { runDispatchLeaseReclamation } = await import("../services/dispatch-reclaim.service.js");
    await runDispatchLeaseReclamation();
  }
  if (job.name === "export-artifact-cleanup") {
    const { purgeExpiredExportArtifacts } = await import("../services/export-expiry.service.js");
    await purgeExpiredExportArtifacts(now);
  }
  if (job.name === "ecommerce-quote-expiry") {
    const { runEcommerceQuoteExpiry } = await import("../services/ecommerce-quote-expiry.service.js");
    await runEcommerceQuoteExpiry(now);
  }
  if (job.name === "ecommerce-order-payment-expiry") {
    const { runEcommerceOrderPaymentExpiry } = await import("../services/ecommerce-order-payment-expiry.service.js");
    await runEcommerceOrderPaymentExpiry(now);
  }
  if (job.name === "ecommerce-payment-reconcile") {
    const { runEcommercePaymentReconcile } = await import("../services/ecommerce-payment-reconcile.service.js");
    await runEcommercePaymentReconcile(now);
  }
}
