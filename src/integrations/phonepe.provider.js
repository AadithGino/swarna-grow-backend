import {
  CallbackType,
  CreateSdkOrderRequest,
  Env,
  ResourceNotFound,
  StandardCheckoutClient,
  StandardCheckoutPayRequest,
} from "@phonepe-pg/pg-sdk-node";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { AppError } from "../lib/app-error.js";
import { unseal } from "../lib/crypto.js";

/** @type {Map<string, StandardCheckoutClient>} */
const clientCache = new Map();

function looksSealed(value) {
  if (!value || typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [iv, tag, encrypted] = parts;
  return (
    iv.length === 16
    && tag.length === 22
    && encrypted.length > 0
    && [iv, tag, encrypted].every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  );
}

function unsealOrRaw(value) {
  if (!value) return value;
  const raw = String(value);
  if (!looksSealed(raw)) {
    // Backward compatibility: some older/manual configs were stored plaintext.
    return raw;
  }
  try {
    return unseal(raw);
  } catch (error) {
    throw new AppError(
      "INTEGRATION_SECRET_DECRYPT_FAILED",
      "PhonePe credentials could not be decrypted. Re-save the integration secrets in tenant settings.",
      422,
      { cause: error?.message ?? "decrypt_failed" },
    );
  }
}

export function resolvePhonePeCredentials(tenant) {
  const config = tenant?.integrationSecrets?.phonepe;
  if (!config?.clientId || !config?.clientSecret) return null;
  return {
    clientId: config.clientId,
    clientSecret: unsealOrRaw(config.clientSecret),
    clientVersion: Number(config.clientVersion ?? 1),
    environment: config.environment ?? env.PHONEPE_ENV,
    webhookUsername: config.webhookUsername ?? "",
    webhookPassword: config.webhookPassword
      ? unsealOrRaw(config.webhookPassword)
      : "",
  };
}

export function getClientFor(credentials) {
  const { clientId, clientSecret, clientVersion, environment } = credentials;
  const cacheKey = `${clientId}:${environment}`;
  if (clientCache.has(cacheKey)) return clientCache.get(cacheKey);
  const sdkEnv = environment === "PRODUCTION" ? Env.PRODUCTION : Env.SANDBOX;
  // SDK getInstance is a process-wide singleton (throws on different credentials).
  // Direct construction supports one cached client per tenant merchant account.
  const client = new StandardCheckoutClient(
    clientId,
    clientSecret,
    Number(clientVersion),
    sdkEnv,
  );
  clientCache.set(cacheKey, client);
  return client;
}

function assertLiveCredentials(credentials) {
  if (!credentials?.clientId || !credentials?.clientSecret) {
    throw new AppError(
      "PAYMENT_GATEWAY_NOT_CONFIGURED",
      "PhonePe client credentials are not configured for this tenant.",
      422,
    );
  }
}

function withRestrictedUpiModes(request, { upiApps = [], upiFlows = ["INTENT"] } = {}) {
  const apps = Array.isArray(upiApps)
    ? upiApps.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
    : [];
  const flows = Array.isArray(upiFlows)
    ? upiFlows
      .map((item) => String(item).trim().toUpperCase())
      .filter((item) => ["INTENT", "COLLECT", "QR"].includes(item))
    : [];
  request.paymentFlow ??= {};
  request.paymentFlow.paymentModeConfig = {
    version: "V2",
    enabledPaymentModes: [
      {
        type: "UPI",
        flows: flows.length ? flows : ["INTENT"],
        ...(apps.length ? { apps } : {}),
      },
    ],
  };
  return request;
}

export const phonePeProvider = {
  async createPayment({
    merchantOrderId,
    amountPaise,
    redirectUrl,
    credentials,
    preferUpiIntentOnly = false,
    upiApps = env.PHONEPE_UPI_APPS,
    upiFlows = env.PHONEPE_UPI_FLOWS,
  }) {
    if (env.PROVIDER_MODE === "mock") {
      return {
        providerOrderId: `mock_${merchantOrderId}`,
        redirectUrl: `${redirectUrl}?mock=success`,
        status: "PENDING",
      };
    }
    assertLiveCredentials(credentials);
    const client = getClientFor(credentials);
    const standardRequest = StandardCheckoutPayRequest.builder()
      .merchantOrderId(merchantOrderId)
      .amount(amountPaise)
      .redirectUrl(redirectUrl)
      .build();
    let response;
    if (preferUpiIntentOnly) {
      const intentRequest = withRestrictedUpiModes(
        StandardCheckoutPayRequest.builder()
          .merchantOrderId(merchantOrderId)
          .amount(amountPaise)
          .redirectUrl(redirectUrl)
          .build(),
        { upiApps, upiFlows },
      );
      try {
        response = await client.pay(intentRequest);
      } catch (error) {
        logger.warn(
          {
            merchantOrderId,
            reason: error?.message,
            upiApps,
            upiFlows,
          },
          "PhonePe restricted UPI checkout failed; retrying with standard checkout",
        );
        response = await client.pay(standardRequest);
      }
    } else {
      response = await client.pay(standardRequest);
    }
    return {
      providerOrderId: response.orderId,
      redirectUrl: response.redirectUrl,
      status: response.state,
      expireAt: response.expireAt,
    };
  },

  async createSdkOrder({ merchantOrderId, amountPaise, redirectUrl, credentials }) {
    if (env.PROVIDER_MODE === "mock") {
      return {
        providerOrderId: `mock_${merchantOrderId}`,
        token: `mock-token-${merchantOrderId}`,
        status: "PENDING",
      };
    }
    assertLiveCredentials(credentials);
    const client = getClientFor(credentials);
    const request = CreateSdkOrderRequest.StandardCheckoutBuilder()
      .merchantOrderId(merchantOrderId)
      .amount(amountPaise)
      .redirectUrl(redirectUrl)
      .build();
    const response = await client.createSdkOrder(request);
    return {
      providerOrderId: response.orderId,
      token: response.token,
      status: response.state,
      expireAt: response.expireAt,
    };
  },

  async getOrderStatus(merchantOrderId, credentials) {
    if (env.PROVIDER_MODE === "mock") {
      return { state: "PENDING", merchantOrderId };
    }
    assertLiveCredentials(credentials);
    const client = getClientFor(credentials);
    return client.getOrderStatus(merchantOrderId);
  },

  verifyCallback(rawBody, authorizationHeader, credentials) {
    assertLiveCredentials(credentials);
    if (!credentials.webhookUsername || !credentials.webhookPassword) {
      throw new AppError(
        "WEBHOOK_CREDENTIALS_MISSING",
        "PhonePe webhook username and password are not configured.",
        422,
      );
    }
    const client = getClientFor(credentials);
    const raw = Buffer.isBuffer(rawBody) ? rawBody.toString() : String(rawBody ?? "");
    return client.validateCallback(
      credentials.webhookUsername,
      credentials.webhookPassword,
      authorizationHeader ?? "",
      raw,
    );
  },

  async verifyCredentials(credentials) {
    if (env.PROVIDER_MODE === "mock") return { verified: true, mode: "mock" };
    assertLiveCredentials(credentials);
    const probeId = `verify_${Date.now()}`;
    try {
      await phonePeProvider.getOrderStatus(probeId, credentials);
      return { verified: true };
    } catch (error) {
      if (error instanceof ResourceNotFound) return { verified: true };
      throw error;
    }
  },
};

export function callbackTypeKey(type) {
  if (typeof type === "string") return type;
  return CallbackType[type] ?? String(type);
}

export function isPhonePeCheckoutCompleted(type) {
  const key = callbackTypeKey(type);
  return key === "CHECKOUT_ORDER_COMPLETED" || key === "PG_ORDER_COMPLETED";
}

export function isPhonePeCheckoutFailed(type) {
  const key = callbackTypeKey(type);
  return (
    key === "CHECKOUT_ORDER_FAILED"
    || key === "PG_ORDER_FAILED"
    || key === "CHECKOUT_TRANSACTION_ATTEMPT_FAILED"
    || key === "PG_TRANSACTION_ATTEMPT_FAILED"
  );
}

export function isPhonePeRefundCallback(type) {
  const key = callbackTypeKey(type);
  return (
    key === "PG_REFUND_COMPLETED"
    || key === "PG_REFUND_FAILED"
    || key === "PG_REFUND_ACCEPTED"
  );
}

export function phonePeCallbackReference(payload = {}) {
  return payload.originalMerchantOrderId ?? payload.merchantOrderId ?? null;
}

export function phonePeCallbackTransactionId(payload = {}) {
  const details = Array.isArray(payload.paymentDetails) ? payload.paymentDetails : [];
  const completed = details.find((row) => row?.state === "COMPLETED") ?? details[0];
  return completed?.transactionId ?? null;
}
