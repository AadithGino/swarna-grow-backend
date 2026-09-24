import { env } from "../config/env.js";

export const MSG91_FLOW_URL = "https://control.msg91.com/api/v5/flow/";

export function toMsg91Mobile(mobile, defaultCountryCode = "91") {
  const digits = String(mobile ?? "").replace(/\D/g, "");
  if (digits.length < 10) throw new Error("Invalid mobile number for MSG91 delivery.");
  if (digits.length === 10) return `${defaultCountryCode}${digits}`;
  return digits;
}

export async function sendMsg91Otp({ mobile, otp } = {}, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const cfg = deps.env ?? env;
  const varName = cfg.MSG91_OTP_VAR || "otp";
  const timeoutMs = cfg.MSG91_SMS_TIMEOUT_MS || 8000;
  const mobiles = toMsg91Mobile(mobile, cfg.MSG91_DEFAULT_COUNTRY_CODE || "91");
  const body = { template_id: cfg.MSG91_OTP_TEMPLATE_ID, sender: cfg.MSG91_SENDER_ID,
    recipients: [{ mobiles, [varName]: String(otp) }] };
  const res = await fetchImpl(MSG91_FLOW_URL, { method: "POST",
    headers: { authkey: cfg.MSG91_AUTH_KEY, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text().catch(() => "");
  let parsed; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!res.ok || parsed?.type === "error")
    throw new Error(`MSG91 delivery failed: ${parsed?.message || parsed?.raw || `HTTP ${res.status}`}`);
  return { providerMessageId: parsed?.request_id ?? null, raw: parsed };
}
