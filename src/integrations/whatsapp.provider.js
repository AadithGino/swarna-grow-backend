import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "../lib/app-error.js";

export const whatsappProvider = {
  async sendTemplate({ to, templateName, language = "en", components = [], credentials = {} }) {
    if (env.PROVIDER_MODE === "mock") {
      return { providerMessageId: `wamid.mock.${randomUUID()}`, status: "SENT" };
    }
    const baseUrl = credentials.baseUrl ?? env.WHATSAPP_BASE_URL; const endpoint = credentials.phoneNumberId && !baseUrl.endsWith("/messages") ? `${baseUrl.replace(/\/$/, "")}/${credentials.phoneNumberId}/messages` : baseUrl; const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${credentials.accessToken ?? env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: { name: templateName, language: { code: language }, components } }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new AppError("DEPENDENCY_UNAVAILABLE", "WhatsApp delivery is temporarily unavailable.", 503);
    const data = await response.json(); return { providerMessageId: data.messages?.[0]?.id, status: "SENT" };
  },
  verifyWebhook(rawBody, signature, secret = env.WHATSAPP_APP_SECRET) {
    if (!signature?.startsWith("sha256=") || !secret) return false;
    const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex")); const received = Buffer.from(signature.slice(7));
    return expected.length === received.length && timingSafeEqual(expected, received);
  },
};
