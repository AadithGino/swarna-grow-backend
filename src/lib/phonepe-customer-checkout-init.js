import { errors } from "./app-error.js";
import { phonePeProvider } from "../integrations/phonepe.provider.js";
import { normalizePhonePeMerchantOrderId } from "./phonepe-gateway-merchant-order-id.js";
import {
  initiatePhonePeCustomerWebCheckout,
  PhonePePersistedCheckoutChannel,
} from "./phonepe-customer-web-checkout.js";

/** `android` | `ios` from customer app headers; empty for web portal. */
export function readClientPlatform(headers = {}) {
  const raw = headers["x-platform"] ?? headers["X-Platform"] ?? "";
  return String(raw).trim();
}

/**
 * Optional override for payment-intent style routes. Omit or `auto` = use `X-Platform`
 * (android|ios → SDK; else hosted). `sdk` / `hosted` force that path regardless of platform.
 */
export function readCheckoutChannel(headers = {}) {
  const raw = headers["x-checkout-channel"] ?? headers["X-Checkout-Channel"] ?? "";
  const v = String(raw).trim().toLowerCase();
  if (!v || v === "auto") return "auto";
  if (v === "sdk" || v === "hosted") return v;
  throw errors.validation([
    {
      field: "x-checkout-channel",
      message: "Must be omitted, auto, sdk, or hosted.",
    },
  ]);
}

export function preferPhonePeSdkOrder(clientPlatform) {
  const platform = String(clientPlatform ?? "").trim().toLowerCase();
  return platform === "android" || platform === "ios";
}

/**
 * Single PhonePe initiation path for all customer checkouts.
 * - `checkoutChannel` `auto`: SDK when `X-Platform` is android|ios, else hosted (browser).
 * - `checkoutChannel` `hosted`: always hosted (`createPayment` + paymentUrl), e.g. Flutter bridge before iOS PhonePeAppId.
 * - `checkoutChannel` `sdk`: always SDK (`createSdkOrder` + token).
 * Scheme routes that force SDK pass `checkoutChannel: "sdk"` explicitly.
 */
export async function initiatePhonePeCustomerCheckout({
  merchantOrderId,
  amountPaise,
  redirectUrl,
  credentials,
  tenantId,
  clientPlatform,
  /** @type {"auto" | "sdk" | "hosted"} */
  checkoutChannel = "auto",
}) {
  const merchantRef = normalizePhonePeMerchantOrderId(merchantOrderId);
  const useSdk =
    checkoutChannel === "sdk"
    || (checkoutChannel !== "hosted" && preferPhonePeSdkOrder(clientPlatform));
  const phonePeCheckoutChannel = useSdk
    ? PhonePePersistedCheckoutChannel.SDK_ORDER
    : PhonePePersistedCheckoutChannel.HOSTED_REDIRECT;

  if (useSdk) {
    const provider = await phonePeProvider.createSdkOrder({
      merchantOrderId: merchantRef,
      amountPaise,
      redirectUrl,
      credentials,
      tenantId,
    });
    return {
      ...provider,
      merchantOrderId: merchantRef,
      phonePeCheckoutChannel,
      checkoutRedirectUrl: null,
    };
  }

  const provider = await initiatePhonePeCustomerWebCheckout({
    merchantOrderId: merchantRef,
    amountPaise,
    redirectUrl,
    credentials,
    tenantId,
  });
  return {
    ...provider,
    merchantOrderId: merchantRef,
    phonePeCheckoutChannel,
  };
}
