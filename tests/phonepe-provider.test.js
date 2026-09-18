import test from "node:test";
import assert from "node:assert/strict";
import { CallbackType } from "@phonepe-pg/pg-sdk-node";
import {
  callbackTypeKey,
  getClientFor,
  isPhonePeCheckoutCompleted,
  isPhonePeCheckoutFailed,
  isPhonePeRefundCallback,
  phonePeCallbackReference,
  phonePeCallbackTransactionId,
  phonePeProvider,
  resolvePhonePeCredentials,
} from "../src/integrations/phonepe.provider.js";
import { normalizePhonePeWebhookEvent } from "../src/lib/phonepe-webhook-payload.js";

test("getClientFor returns the same instance for repeated calls with same tenant credentials", async () => {
  const credentials = {
    clientId: "TEST-CLIENT-ID",
    clientSecret: "test-secret-value",
    clientVersion: 1,
    environment: "SANDBOX",
    webhookUsername: "user",
    webhookPassword: "pass",
  };
  const first = getClientFor(credentials);
  const second = getClientFor(credentials);
  assert.equal(first, second);
});

test("getClientFor returns different instances for different client ids", async () => {
  const base = {
    clientSecret: "test-secret-value",
    clientVersion: 1,
    environment: "SANDBOX",
    webhookUsername: "user",
    webhookPassword: "pass",
  };
  const first = getClientFor({ ...base, clientId: "CLIENT-A" });
  const second = getClientFor({ ...base, clientId: "CLIENT-B" });
  assert.notEqual(first, second);
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
