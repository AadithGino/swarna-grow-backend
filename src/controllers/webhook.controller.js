import { Tenant } from "../models/index.js";
import { sendSuccess } from "../lib/response.js";
import { phonePeProvider, resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import { whatsappProvider } from "../integrations/whatsapp.provider.js";
import { getQueue } from "../queues/index.js";
import { AppError } from "../lib/app-error.js";
import { unseal } from "../lib/crypto.js";
import { buildPhonePeWebhookEventId } from "../lib/phonepe-webhook-identity.js";
import { buildWhatsAppWebhookEventId } from "../lib/whatsapp-webhook-identity.js";
import { assertWebhookTenantReceivable } from "../lib/webhook-tenant-guard.js";
import {
  persistVerifiedWebhook,
  persistWebhookSignatureFailure,
} from "../services/webhook-event.service.js";

async function enqueueWebhookJob(event, jobName) {
  if (!event) return;
  await getQueue("webhooks")?.add(
    jobName,
    { webhookEventId: event._id },
    { jobId: event._id, attempts: 5, backoff: { type: "exponential", delay: 5000 } },
  );
}

export const phonepe = async (req, res) => {
  await assertWebhookTenantReceivable(req.params.tenantId);
  const tenant = await Tenant.findById(req.params.tenantId).select("+integrationSecrets").lean();
  const raw = req.rawBody;
  const authorization = req.headers.authorization ?? req.headers.Authorization;
  const credentials = resolvePhonePeCredentials(tenant);
  let callback;
  try {
    callback = phonePeProvider.verifyCallback(raw, authorization, credentials, req.params.tenantId);
  } catch {
    await persistWebhookSignatureFailure({
      tenantId: req.params.tenantId,
      provider: "PHONEPE",
      rawBody: raw,
      signatureHeader: authorization,
      clientIp: req.ip,
    });
    throw new AppError("WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature.", 401);
  }

  const payload = { type: callback.type, payload: callback.payload };
  const providerEventId = buildPhonePeWebhookEventId({
    tenantId: req.params.tenantId,
    type: callback.type,
    payload: callback.payload,
    rawBody: raw,
  });
  const event = await persistVerifiedWebhook({
    tenantId: req.params.tenantId,
    provider: "PHONEPE",
    providerEventId,
    signatureHeader: authorization,
    rawBody: raw,
    payload,
  });
  await enqueueWebhookJob(event, "phonepe");
  sendSuccess(res, { received: true, eventId: event?._id ?? null });
};

export const whatsapp = async (req, res) => {
  const tenant = await Tenant.findById(req.params.tenantId).select("+integrationSecrets").lean();
  const raw = req.rawBody;
  const signatureHeader = req.headers["x-hub-signature-256"];
  const sealed = tenant?.integrationSecrets?.whatsapp?.appSecret;
  if (!whatsappProvider.verifyWebhook(raw, signatureHeader, sealed ? unseal(sealed) : undefined)) {
    await persistWebhookSignatureFailure({
      tenantId: req.params.tenantId,
      provider: "WHATSAPP",
      rawBody: raw,
      signatureHeader,
      clientIp: req.ip,
    });
    throw new AppError("WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature.", 401);
  }
  let payload;
  try {
    payload = JSON.parse(raw.toString());
  } catch {
    throw new AppError("WEBHOOK_PAYLOAD_INVALID", "Invalid webhook payload.", 400);
  }
  const providerEventId = buildWhatsAppWebhookEventId({
    tenantId: req.params.tenantId,
    payload,
  });
  const event = await persistVerifiedWebhook({
    tenantId: req.params.tenantId,
    provider: "WHATSAPP",
    providerEventId,
    signatureHeader,
    rawBody: raw,
    payload,
  });
  await enqueueWebhookJob(event, "whatsapp");
  sendSuccess(res, { received: true, eventId: event?._id ?? null });
};
