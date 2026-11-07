import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveDigitalMetalsCheckoutMode,
  assertPhonePeCredentialsForLiveCheckout,
} from "../src/lib/digital-metals-demo-policy.js";
import { isMockDigitalMetalsPaymentAttempt } from "../src/lib/digital-metals-checkout-init.js";

test.beforeEach(() => {
  delete process.env.DIGITAL_METALS_CHECKOUT_MODE;
});

test("unknown checkout mode is rejected; demo and mock modes resolve explicitly", () => {
  process.env.PROVIDER_MODE = "live";
  process.env.DIGITAL_METALS_CHECKOUT_MODE = "not-a-mode";
  assert.throws(
    () => resolveDigitalMetalsCheckoutMode(),
    (err) => err.code === "CHECKOUT_MODE_INVALID",
  );
  process.env.DIGITAL_METALS_CHECKOUT_MODE = "demo";
  assert.equal(resolveDigitalMetalsCheckoutMode(), "DIGITAL_METALS_DEMO");
  process.env.DIGITAL_METALS_CHECKOUT_MODE = "mock";
  assert.equal(resolveDigitalMetalsCheckoutMode(), "MOCK_PROVIDER");
});

test("live checkout policy rejects missing credentials; mock attempts require persisted checkoutMode", () => {
  process.env.PROVIDER_MODE = "live";
  process.env.DIGITAL_METALS_CHECKOUT_MODE = "live";
  assert.equal(resolveDigitalMetalsCheckoutMode(), "LIVE_REQUIRED");
  assert.throws(
    () => assertPhonePeCredentialsForLiveCheckout({}),
    (err) => err.code === "PHONEPE_NOT_CONFIGURED",
  );
  assert.equal(
    isMockDigitalMetalsPaymentAttempt({
      status: "INITIATED",
      checkoutMode: "LIVE",
      providerOrderId: "mock_x",
      sdkToken: "mock-token-x",
    }),
    false,
  );
  assert.equal(
    isMockDigitalMetalsPaymentAttempt({
      status: "INITIATED",
      checkoutMode: "DIGITAL_METALS_DEMO",
    }),
    true,
  );
});
