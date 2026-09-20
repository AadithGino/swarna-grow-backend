import test from "node:test";
import assert from "node:assert/strict";
import { CallbackType } from "@phonepe-pg/pg-sdk-node";
import {
  callbackTypeKey,
  getClientFor,
  invalidatePhonePeClientCache,
  isPhonePeCheckoutCompleted,
  isPhonePeCheckoutFailed,
  isPhonePeRefundCallback,
  isPhonePeTransactionAttemptFailed,
  phonePeCallbackReference,
  phonePeCallbackTransactionId,
  phonePeClientCacheKey,
  phonePeProvider,
  resolvePhonePeCredentials,
} from "../src/integrations/phonepe.provider.js";
import {
  classifyPhonePeCallback,
  PhonePeCallbackClass,
} from "../src/lib/phonepe-callback-classification.js";
import { buildPhonePeWebhookEventId } from "../src/lib/phonepe-webhook-identity.js";
import { normalizePhonePeWebhookEvent } from "../src/lib/phonepe-webhook-payload.js";

test("getClientFor returns the same instance for repeated calls with same tenant credentials", async () => {
  const tenantId = "tenant_cache_a";
  const credentials = {
    clientId: "TEST-CLIENT-ID",
    clientSecret: "test-secret-value",
    clientVersion: 1,
    environment: "SANDBOX",
    webhookUsername: "user",
    webhookPassword: "pass",
  };
  const first = getClientFor(credentials, tenantId);
  const second = getClientFor(credentials, tenantId);
  assert.equal(first, second);
  assert.match(phonePeClientCacheKey(credentials, tenantId), /^tenant_cache_a:TEST-CLIENT-ID:/);
  assert.doesNotMatch(phonePeClientCacheKey(credentials, tenantId), /test-secret-value/);
});

test("getClientFor returns different instances for different client ids", async () => {
  const base = {
    clientSecret: "test-secret-value",
    clientVersion: 1,
    environment: "SANDBOX",
    webhookUsername: "user",
    webhookPassword: "pass",
  };
  const first = getClientFor({ ...base, clientId: "CLIENT-A" }, "tenant_a");
  const second = getClientFor({ ...base, clientId: "CLIENT-B" }, "tenant_a");
  assert.notEqual(first, second);
});

test("tenants with identical clientId but different secrets do not share SDK clients", () => {
  const shared = {
    clientId: "SHARED-CLIENT",
    clientVersion: 1,
    environment: "SANDBOX",
    webhookUsername: "user",
    webhookPassword: "pass",
  };
  const tenantA = "tenant_shared_a";
  const tenantB = "tenant_shared_b";
  const clientA = getClientFor({ ...shared, clientSecret: "secret-a" }, tenantA);
  const clientB = getClientFor({ ...shared, clientSecret: "secret-b" }, tenantB);
  assert.notEqual(clientA, clientB);
  invalidatePhonePeClientCache(tenantA);
  const clientA2 = getClientFor({ ...shared, clientSecret: "secret-a" }, tenantA);
  assert.notEqual(clientA, clientA2);
  assert.equal(getClientFor({ ...shared, clientSecret: "secret-b" }, tenantB), clientB);
});

test("createPayment mock mode does not require SDK credentials", async () => {
  const result = await phonePeProvider.createPayment({
    merchantOrderId: "intent_1",
    amountPaise: 50000,
    redirectUrl: "https://example.com/return",
    credentials: null,
  });
  assert.equal(result.status, "PENDING");
  assert.match(result.redirectUrl, /mock=success/);
});

test("createSdkOrder mock mode returns token", async () => {
  const result = await phonePeProvider.createSdkOrder({
    merchantOrderId: "intent_2",
    amountPaise: 50000,
    redirectUrl: "https://example.com/return",
    credentials: null,
  });
  assert.equal(result.status, "PENDING");
  assert.match(result.token, /^mock-token-/);
});

test("callback helpers classify sdk callback types", () => {
  assert.equal(isPhonePeCheckoutCompleted(CallbackType.CHECKOUT_ORDER_COMPLETED), true);
  assert.equal(isPhonePeCheckoutFailed(CallbackType.CHECKOUT_ORDER_FAILED), true);
  assert.equal(isPhonePeRefundCallback(CallbackType.PG_REFUND_COMPLETED), true);
  assert.equal(callbackTypeKey(CallbackType.CHECKOUT_ORDER_COMPLETED), "CHECKOUT_ORDER_COMPLETED");
});

test("transaction attempt failed is not terminal checkout failure", () => {
  assert.equal(
    isPhonePeTransactionAttemptFailed(CallbackType.CHECKOUT_TRANSACTION_ATTEMPT_FAILED),
    true,
  );
  assert.equal(
    isPhonePeCheckoutFailed(CallbackType.CHECKOUT_TRANSACTION_ATTEMPT_FAILED),
    false,
  );
  assert.equal(
    classifyPhonePeCallback(CallbackType.CHECKOUT_TRANSACTION_ATTEMPT_FAILED),
    PhonePeCallbackClass.TRANSACTION_ATTEMPT_FAILED,
  );
});

test("normalizePhonePeWebhookEvent marks attempt failure separately from order failure", () => {
  const normalized = normalizePhonePeWebhookEvent({
    type: CallbackType.CHECKOUT_TRANSACTION_ATTEMPT_FAILED,
    payload: {
      originalMerchantOrderId: "intent_retry",
      amount: 50000,
      paymentDetails: [{ state: "FAILED", transactionId: "txn_attempt_1" }],
    },
  });
  assert.equal(normalized.attemptFailed, true);
  assert.equal(normalized.failed, false);
  assert.equal(normalized.completed, false);
  assert.equal(normalized.classification, PhonePeCallbackClass.TRANSACTION_ATTEMPT_FAILED);
});

test("webhook event ids differ for attempt failure vs order completion on same order", () => {
  const tenantId = "tenant_abc";
  const basePayload = {
    originalMerchantOrderId: "order_1",
    amount: 10000,
  };
  const attemptId = buildPhonePeWebhookEventId({
    tenantId,
    type: CallbackType.CHECKOUT_TRANSACTION_ATTEMPT_FAILED,
    payload: {
      ...basePayload,
      paymentDetails: [{ state: "FAILED", transactionId: "txn_a" }],
    },
  });
  const successId = buildPhonePeWebhookEventId({
    tenantId,
    type: CallbackType.CHECKOUT_ORDER_COMPLETED,
    payload: {
      ...basePayload,
      paymentDetails: [{ state: "COMPLETED", transactionId: "txn_b" }],
    },
  });
  assert.notEqual(attemptId, successId);
  assert.match(attemptId, /^pe:tenant_abc:/);
});

test("normalizePhonePeWebhookEvent maps sdk checkout completion payload", () => {
  const normalized = normalizePhonePeWebhookEvent({
    type: CallbackType.CHECKOUT_ORDER_COMPLETED,
    payload: {
      originalMerchantOrderId: "intent_abc",
      amount: 50000,
      paymentDetails: [{ state: "COMPLETED", transactionId: "txn_123" }],
    },
  });
  assert.equal(normalized.format, "sdk");
  assert.equal(normalized.reference, "intent_abc");
  assert.equal(normalized.transactionId, "txn_123");
  assert.equal(normalized.completed, true);
});

test("normalizePhonePeWebhookEvent returns unknown for non-sdk payloads", () => {
  const normalized = normalizePhonePeWebhookEvent({
    data: { state: "COMPLETED", amount: 25000 },
  });
  assert.equal(normalized.format, "unknown");
  assert.equal(normalized.reference, null);
  assert.equal(normalized.completed, false);
});

test("phonePeCallbackReference prefers originalMerchantOrderId", () => {
  assert.equal(
    phonePeCallbackReference({
      originalMerchantOrderId: "mine",
      merchantOrderId: "other",
    }),
    "mine",
  );
  assert.equal(
    phonePeCallbackTransactionId({
      paymentDetails: [{ state: "COMPLETED", transactionId: "txn_1" }],
    }),
    "txn_1",
  );
});

test("resolvePhonePeCredentials supports plaintext fallback for manual DB values", () => {
  const tenant = {
    integrationSecrets: {
      phonepe: {
        clientId: "MANUAL_ID",
        clientSecret: "plain.secret.value",
        clientVersion: 1,
        webhookUsername: "webhook-user",
        webhookPassword: "plain.webhook.password",
        environment: "SANDBOX",
      },
    },
  };
  const creds = resolvePhonePeCredentials(tenant);
  assert.equal(creds?.clientId, "MANUAL_ID");
  assert.equal(creds?.clientSecret, "plain.secret.value");
  assert.equal(creds?.webhookPassword, "plain.webhook.password");
  assert.equal(creds?.environment, "SANDBOX");
});

test("resolvePhonePeCredentials fails fast for sealed values that cannot be decrypted", () => {
  const tenant = {
    integrationSecrets: {
      phonepe: {
        clientId: "ENCRYPTED_ID",
        clientSecret: "abcdefghijklmnop.abcdefghijklmnopqrstuv.abc",
        clientVersion: 1,
        webhookUsername: "webhook-user",
        webhookPassword: "abcdefghijklmnop.abcdefghijklmnopqrstuv.abc",
        environment: "SANDBOX",
      },
    },
  };
  assert.throws(
    () => resolvePhonePeCredentials(tenant),
    (err) => err?.code === "INTEGRATION_SECRET_DECRYPT_FAILED",
  );
});
