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

export function preferPhonePeSdkOrder(clientPlatform) {
  const platform = String(clientPlatform ?? "").trim().toLowerCase();
  return platform === "android" || platform === "ios";
}

/**
 * Single PhonePe initiation path for all customer checkouts.
 * - Web (no X-Platform): hosted redirect (`createPayment`).
 * - Flutter (`X-Platform: android|ios`): SDK order (`createSdkOrder` + token).
 * - `checkoutChannel: "sdk"` forces SDK (scheme `/pay/sdk-order` routes).
 */
export async function initiatePhonePeCustomerCheckout({
  merchantOrderId,
  amountPaise,
  redirectUrl,
  credentials,
  tenantId,
  clientPlatform,
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
