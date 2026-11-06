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

/** Hosted PhonePe checkout (browser). Mobile SDK orders go through initiatePhonePeCustomerCheckout. */
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

export const PhonePePersistedCheckoutChannel = {
  SDK_ORDER: "SDK_ORDER",
  HOSTED_REDIRECT: "HOSTED_REDIRECT",
};

export function readPersistedPhonePeCheckoutChannel(row) {
  const channel = row?.providerPayload?.phonePeCheckoutChannel;
  if (
    channel === PhonePePersistedCheckoutChannel.SDK_ORDER
    || channel === PhonePePersistedCheckoutChannel.HOSTED_REDIRECT
  ) {
    return channel;
  }
  return null;
}

export function readPersistedPhonePeCheckoutRedirectUrl(attempt) {
  const fromPayload = attempt?.providerPayload?.checkoutRedirectUrl;
  if (typeof fromPayload === "string" && fromPayload.startsWith("http")) return fromPayload;
  return null;
}

export function mapPhonePeCustomerCheckoutResponse(row, phonePeEnvironment) {
  const persistedChannel = readPersistedPhonePeCheckoutChannel(row);
  let hostedUrl = readPersistedPhonePeCheckoutRedirectUrl(row);
  let sdkToken = row.sdkToken ?? null;
  if (persistedChannel === PhonePePersistedCheckoutChannel.SDK_ORDER) {
    hostedUrl = null;
  }
  if (persistedChannel === PhonePePersistedCheckoutChannel.HOSTED_REDIRECT) {
    sdkToken = null;
  }
  const peEnv = phonePeEnvironment ?? env.PHONEPE_ENV;
  const paymentUrl =
    hostedUrl ?? (sdkToken ? phonePeSdkWebGatewayUrl(sdkToken, peEnv) : null);
  const checkoutKind =
    persistedChannel
    ?? (hostedUrl ? PhonePePersistedCheckoutChannel.HOSTED_REDIRECT : null)
    ?? (sdkToken ? PhonePePersistedCheckoutChannel.SDK_ORDER : null);
  return {
    checkoutKind,
    provider: checkoutKind ? "PHONEPE" : null,
    token: sdkToken,
    sdkToken,
    gatewayUrl: paymentUrl,
    paymentUrl,
    providerOrderId:
      row.providerOrderId
      ?? row?.providerPayload?.phonePeProviderOrderId
      ?? null,
  };
}

/** @deprecated Prefer mergePhonePeProviderInitPayload */
export function mergePhonePeCheckoutProviderPayload(existing, checkoutRedirectUrl) {
  if (!checkoutRedirectUrl) return existing ?? undefined;
  return mergePhonePeProviderInitPayload(existing, {
    checkoutChannel: PhonePePersistedCheckoutChannel.HOSTED_REDIRECT,
    provider: { checkoutRedirectUrl, redirectUrl: checkoutRedirectUrl },
  });
}

/**
 * Persist PhonePe initiation snapshot for dashboard support + stable client mapping.
 * `merchantOrderId` sent to PhonePe must equal `phonePeProviderOrderId`'s order sibling field
 * on the attempt/payment row — reconcile uses merchantOrderId, dashboard search uses the same.
 */
export function mergePhonePeProviderInitPayload(existing, { checkoutChannel, provider }) {
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  const hostedUrl =
    checkoutChannel === PhonePePersistedCheckoutChannel.HOSTED_REDIRECT
      ? provider?.checkoutRedirectUrl ?? provider?.redirectUrl ?? null
      : null;
  if (checkoutChannel === PhonePePersistedCheckoutChannel.SDK_ORDER) {
    delete base.checkoutRedirectUrl;
  }
  const next = {
    ...base,
    phonePeCheckoutChannel: checkoutChannel,
    phonePeProviderOrderId: provider?.providerOrderId ?? base.phonePeProviderOrderId ?? null,
    phonePeExpireAt: provider?.expireAt ?? base.phonePeExpireAt ?? null,
    phonePeInitiatedAt: base.phonePeInitiatedAt ?? new Date().toISOString(),
  };
  if (hostedUrl) next.checkoutRedirectUrl = hostedUrl;
  return next;
}
