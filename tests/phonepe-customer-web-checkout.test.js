import test from "node:test";
import assert from "node:assert/strict";
import {
  mapPhonePeCustomerCheckoutResponse,
  mergePhonePeProviderInitPayload,
  PhonePePersistedCheckoutChannel,
} from "../src/lib/phonepe-customer-web-checkout.js";
import { normalizePhonePeMerchantOrderId } from "../src/lib/phonepe-gateway-merchant-order-id.js";

test("normalizePhonePeMerchantOrderId rejects empty and overlong ids", () => {
  assert.throws(() => normalizePhonePeMerchantOrderId(""), /required/i);
  assert.throws(
    () => normalizePhonePeMerchantOrderId("x".repeat(81)),
    /exceeds/i,
  );
  assert.equal(normalizePhonePeMerchantOrderId(" epay_abc "), "epay_abc");
});

test("mergePhonePeProviderInitPayload stores PhonePe order id for dashboard lookup", () => {
  const payload = mergePhonePeProviderInitPayload(null, {
    checkoutChannel: PhonePePersistedCheckoutChannel.SDK_ORDER,
    provider: {
      providerOrderId: "OMO123",
      token: "tok",
      expireAt: 1_700_000_000_000,
    },
  });
  assert.equal(payload.phonePeCheckoutChannel, "SDK_ORDER");
  assert.equal(payload.phonePeProviderOrderId, "OMO123");
  assert.equal(payload.checkoutRedirectUrl, undefined);
});

test("mapPhonePeCustomerCheckoutResponse respects persisted channel over stale payload", () => {
  const row = {
    sdkToken: "sdk-tok",
    providerPayload: {
      phonePeCheckoutChannel: PhonePePersistedCheckoutChannel.HOSTED_REDIRECT,
      checkoutRedirectUrl: "https://mercury.phonepe.com/transact/v2?token=old",
    },
  };
  const mapped = mapPhonePeCustomerCheckoutResponse(row, "SANDBOX");
  assert.equal(mapped.checkoutKind, "HOSTED_REDIRECT");
  assert.equal(mapped.token, null);
  assert.match(String(mapped.paymentUrl), /phonepe\.com/);
});
