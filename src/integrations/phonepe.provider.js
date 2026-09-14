import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "../lib/app-error.js";

export const phonePeProvider = {
  async createPayment({ merchantTransactionId, amountPaise, redirectUrl, callbackUrl, mobile, credentials = {} }) {
    if (env.PROVIDER_MODE === "mock") return { providerOrderId: `mock_${merchantTransactionId}`, redirectUrl: `${redirectUrl}?mock=success`, status: "PENDING" };
    const merchantId = credentials.merchantId ?? env.PHONEPE_MERCHANT_ID; const saltKey = credentials.saltKey ?? env.PHONEPE_SALT_KEY; const saltIndex = credentials.saltIndex ?? env.PHONEPE_SALT_INDEX;
    const payload = Buffer.from(JSON.stringify({ merchantId, merchantTransactionId, merchantUserId: mobile, amount: amountPaise, redirectUrl, callbackUrl, paymentInstrument: { type: "PAY_PAGE" } })).toString("base64");
    const path = "/pg/v1/pay"; const checksum = createHash("sha256").update(`${payload}${path}${saltKey}`).digest("hex") + `###${saltIndex}`;
    const response = await fetch(`${env.PHONEPE_BASE_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-VERIFY": checksum }, body: JSON.stringify({ request: payload }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new AppError("DEPENDENCY_UNAVAILABLE", "The payment gateway is temporarily unavailable.", 503);
    const data = await response.json(); return { providerOrderId: merchantTransactionId, redirectUrl: data.data?.instrumentResponse?.redirectInfo?.url, status: "PENDING", raw: data };
  },
  verifyWebhook(rawBody, endpointPath, signature, saltKey = env.PHONEPE_SALT_KEY, saltIndex = env.PHONEPE_SALT_INDEX) {
    const payload = JSON.parse(rawBody.toString()); const base64Payload = payload.response ?? rawBody.toString("base64");
    const expected = createHash("sha256").update(`${base64Payload}${endpointPath}${saltKey}`).digest("hex") + `###${saltIndex}`;
    return expected === signature;
  },
};
