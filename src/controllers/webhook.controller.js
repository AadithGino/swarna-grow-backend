import { Tenant } from "../models/index.js";
import { sendSuccess } from "../lib/response.js";
import { phonePeProvider, resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import { whatsappProvider } from "../integrations/whatsapp.provider.js";
import { persistWebhook } from "../services/payment.service.js";
import { getQueue } from "../queues/index.js";
import { AppError } from "../lib/app-error.js";
import { sha256, unseal } from "../lib/crypto.js";

export const phonepe = async (req, res) => {
  const tenant = await Tenant.findById(req.params.tenantId).select("+integrationSecrets").lean();
  const raw = req.rawBody;
  const authorization = req.headers.authorization ?? req.headers.Authorization;
  const credentials = resolvePhonePeCredentials(tenant);
  let callback;
  try {
    callback = phonePeProvider.verifyCallback(raw, authorization, credentials);
  } catch {
    const event = await persistWebhook({
      tenantId: req.params.tenantId,
      provider: "PHONEPE",
      providerEventId: `signature_${sha256(raw).slice(0, 24)}`,
      signature: authorization,
      rawBody: raw,
      payload: {},
    });
    if (event) {
      event.status = "SIGNATURE_FAILED";
      event.error = "Invalid webhook signature";
      await event.save();
    }
    throw new AppError("WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature.", 401);
  }

  const payload = { type: callback.type, payload: callback.payload };
  const providerEventId =
    callback.payload?.orderId
    ?? callback.payload?.paymentDetails?.[0]?.transactionId
    ?? `pe_${callback.payload?.originalMerchantOrderId ?? callback.payload?.merchantOrderId ?? Date.now()}`;
  const event = await persistWebhook({
    tenantId: req.params.tenantId,
    provider: "PHONEPE",
    providerEventId,
    signature: authorization,
    rawBody: raw,
    payload,
  });
  if (event) {
    await getQueue("webhooks")?.add(
      "phonepe",
      { webhookEventId: event._id },
      { jobId: event._id, attempts: 5, backoff: { type: "exponential", delay: 5000 } },
    );
  }
  sendSuccess(res, { received: true, eventId: event?._id ?? null });
};

export const whatsapp = async (req, res) => {
  const tenant = await Tenant.findById(req.params.tenantId).select("+integrationSecrets").lean();
  const sealed = tenant?.integrationSecrets?.whatsapp?.appSecret;
  if (!whatsappProvider.verifyWebhook(req.rawBody, req.headers["x-hub-signature-256"], sealed ? unseal(sealed) : undefined)) {
    const event = await persistWebhook({ tenantId: req.params.tenantId, provider: "WHATSAPP", providerEventId: `signature_${sha256(req.rawBody).slice(0, 24)}`, signature: req.headers["x-hub-signature-256"], rawBody: req.rawBody, payload: {} });
    if (event) { event.status = "SIGNATURE_FAILED"; event.error = "Invalid webhook signature"; await event.save(); }
    throw new AppError("WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature.", 401);
  }
  let payload;
  try { payload = JSON.parse(req.rawBody.toString()); } catch { throw new AppError("WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature.", 401); }
  const status = payload.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
  const providerEventId = status?.id ?? payload.entry?.[0]?.id ?? `wa_${Date.now()}`;
  const event = await persistWebhook({ tenantId: req.params.tenantId, provider: "WHATSAPP", providerEventId, signature: req.headers["x-hub-signature-256"], rawBody: req.rawBody, payload });
  if (event) await getQueue("webhooks")?.add("whatsapp", { webhookEventId: event._id }, { jobId: event._id, attempts: 5, backoff: { type: "exponential", delay: 5000 } });
  sendSuccess(res, { received: true, eventId: event?._id ?? null });
};
