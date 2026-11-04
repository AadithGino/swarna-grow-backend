import { env } from "../config/env.js";

function normalizePhonePeEnvironment(value) {
  const raw = String(value ?? env.PHONEPE_ENV ?? "PRODUCTION").trim().toUpperCase();
  if (raw === "SANDBOX" || raw === "UAT" || raw === "PREPROD" || raw === "TEST") return "SANDBOX";
  return "PRODUCTION";
}

/** Hosted web checkout URL for a PhonePe SDK order token (not the merchant return URL). */
export function phonePeSdkWebGatewayUrl(token, phonePeEnvironment) {
  const trimmed = String(token ?? "").trim();
  if (!trimmed) return null;
  const environment = normalizePhonePeEnvironment(phonePeEnvironment);
  const base =
    environment === "SANDBOX"
      ? "https://mercury-uat.phonepe.com/transact/pg"
      : "https://mercury.phonepe.com/transact/pg";
  return `${base}?token=${encodeURIComponent(trimmed)}`;
}
