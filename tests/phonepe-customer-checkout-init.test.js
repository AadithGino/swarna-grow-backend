import test from "node:test";
import assert from "node:assert/strict";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import {
  initiatePhonePeCustomerCheckout,
  preferPhonePeSdkOrder,
  readCheckoutChannel,
  readClientPlatform,
} from "../src/lib/phonepe-customer-checkout-init.js";

test("readClientPlatform reads x-platform header", () => {
  assert.equal(readClientPlatform({ "x-platform": "android" }), "android");
  assert.equal(readClientPlatform({ "X-Platform": "ios" }), "ios");
  assert.equal(readClientPlatform({}), "");
});

test("preferPhonePeSdkOrder is true only for android and ios", () => {
  assert.equal(preferPhonePeSdkOrder("android"), true);
  assert.equal(preferPhonePeSdkOrder("ios"), true);
  assert.equal(preferPhonePeSdkOrder("web"), false);
  assert.equal(preferPhonePeSdkOrder(""), false);
});

test("readCheckoutChannel defaults and normalizes", () => {
  assert.equal(readCheckoutChannel({}), "auto");
  assert.equal(readCheckoutChannel({ "x-checkout-channel": "auto" }), "auto");
  assert.equal(readCheckoutChannel({ "X-Checkout-Channel": "SDK" }), "sdk");
  assert.equal(readCheckoutChannel({ "x-checkout-channel": "Hosted" }), "hosted");
});

test("readCheckoutChannel rejects invalid values", () => {
  assert.throws(() => readCheckoutChannel({ "x-checkout-channel": "native" }), (err) => {
    assert.equal(err.code, "VALIDATION_FAILED");
    assert.equal(err.details?.[0]?.field, "x-checkout-channel");
    return true;
  });
});

test("checkoutChannel hosted forces createPayment even with android platform", async () => {
  const originalSdk = phonePeProvider.createSdkOrder.bind(phonePeProvider);
  const originalPay = phonePeProvider.createPayment.bind(phonePeProvider);
  let sdkCalls = 0;
  let payCalls = 0;
  phonePeProvider.createSdkOrder = async (args) => {
    sdkCalls += 1;
    return originalSdk(args);
  };
  phonePeProvider.createPayment = async () => {
    payCalls += 1;
    return { providerOrderId: "pay1", redirectUrl: "https://phonepe.test/pay" };
  };
  try {
    await initiatePhonePeCustomerCheckout({
      merchantOrderId: "ord_hosted",
      amountPaise: 100,
      redirectUrl: "https://example.com/return",
      credentials: null,
      tenantId: "ten_test",
      clientPlatform: "android",
      checkoutChannel: "hosted",
    });
    assert.equal(sdkCalls, 0);
    assert.equal(payCalls, 1);
  } finally {
    phonePeProvider.createSdkOrder = originalSdk;
    phonePeProvider.createPayment = originalPay;
  }
});

test("initiatePhonePeCustomerCheckout uses createSdkOrder for mobile platform", async () => {
  const originalSdk = phonePeProvider.createSdkOrder.bind(phonePeProvider);
  const originalPay = phonePeProvider.createPayment.bind(phonePeProvider);
  let sdkCalls = 0;
  let payCalls = 0;
  phonePeProvider.createSdkOrder = async (args) => {
    sdkCalls += 1;
    return originalSdk(args);
  };
  phonePeProvider.createPayment = async (args) => {
    payCalls += 1;
    return originalPay(args);
  };
  try {
    await initiatePhonePeCustomerCheckout({
      merchantOrderId: "ord_test",
      amountPaise: 100,
      redirectUrl: "https://example.com/return",
      credentials: null,
      tenantId: "ten_test",
      clientPlatform: "android",
    });
    assert.equal(sdkCalls, 1);
    assert.equal(payCalls, 0);

    sdkCalls = 0;
    payCalls = 0;
    await initiatePhonePeCustomerCheckout({
      merchantOrderId: "ord_test2",
      amountPaise: 100,
      redirectUrl: "https://example.com/return",
      credentials: null,
      tenantId: "ten_test",
      clientPlatform: "",
    });
    assert.equal(sdkCalls, 0);
    assert.equal(payCalls, 1);
  } finally {
    phonePeProvider.createSdkOrder = originalSdk;
    phonePeProvider.createPayment = originalPay;
  }
});

test("checkoutChannel sdk forces SDK even without platform header", async () => {
  const originalSdk = phonePeProvider.createSdkOrder.bind(phonePeProvider);
  const originalPay = phonePeProvider.createPayment.bind(phonePeProvider);
  let sdkCalls = 0;
  let payCalls = 0;
  phonePeProvider.createSdkOrder = async (args) => {
    sdkCalls += 1;
    return originalSdk(args);
  };
  phonePeProvider.createPayment = async () => {
    payCalls += 1;
    return { providerOrderId: "x", redirectUrl: "https://phonepe.test" };
  };
  try {
    await initiatePhonePeCustomerCheckout({
      merchantOrderId: "ord_sdk",
      amountPaise: 100,
      redirectUrl: "https://example.com/return",
      credentials: null,
      tenantId: "ten_test",
      clientPlatform: "",
      checkoutChannel: "sdk",
    });
    assert.equal(sdkCalls, 1);
    assert.equal(payCalls, 0);
  } finally {
    phonePeProvider.createSdkOrder = originalSdk;
    phonePeProvider.createPayment = originalPay;
  }
});
