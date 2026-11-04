import { env } from "../config/env.js";
import { phonePeProvider } from "../integrations/phonepe.provider.js";
import { phonePeSdkWebGatewayUrl } from "./phonepe-gateway-url.js";

export function customerPhonePeWebCheckoutOptions() {
  return {
    preferUpiIntentOnly: env.PHONEPE_UPI_INTENT_ONLY === true,
    upiApps: env.PHONEPE_UPI_APPS,
    upiFlows: env.PHONEPE_UPI_FLOWS,
  };
}

/** Standard hosted checkout for browser clients (Next.js). Flutter uses createSdkOrder instead. */
export async function initiatePhonePeCustomerWebCheckout({
  merchantOrderId,
  amountPaise,
  redirectUrl,
  credentials,
  tenantId,
}) {
  const provider = await phonePeProvider.createPayment({
    merchantOrderId,
    amountPaise,
    redirectUrl,
    credentials,
    tenantId,
    ...customerPhonePeWebCheckoutOptions(),
  });
  return {
    ...provider,
    checkoutRedirectUrl: provider.redirectUrl ?? null,
  };
}

export function readPersistedPhonePeCheckoutRedirectUrl(attempt) {
  const fromPayload = attempt?.providerPayload?.checkoutRedirectUrl;
  if (typeof fromPayload === "string" && fromPayload.startsWith("http")) return fromPayload;
  return null;
}

export function mapPhonePeCustomerCheckoutResponse(row) {
  const hostedUrl = readPersistedPhonePeCheckoutRedirectUrl(row);
  const sdkToken = row.sdkToken ?? null;
  const paymentUrl =
    hostedUrl ?? (sdkToken ? phonePeSdkWebGatewayUrl(sdkToken, env.PHONEPE_ENV) : null);
  const checkoutKind = hostedUrl ? "HOSTED_REDIRECT" : sdkToken ? "SDK_ORDER" : null;
  return {
    checkoutKind,
    provider: checkoutKind ? "PHONEPE" : null,
    token: sdkToken,
    sdkToken,
    gatewayUrl: paymentUrl,
    paymentUrl,
  };
}

export function mergePhonePeCheckoutProviderPayload(existing, checkoutRedirectUrl) {
  if (!checkoutRedirectUrl) return existing ?? undefined;
  return { ...(existing && typeof existing === "object" ? existing : {}), checkoutRedirectUrl };
}
