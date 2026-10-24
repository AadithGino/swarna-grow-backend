import { AppError } from "./app-error.js";
import { phonePeProvider } from "../integrations/phonepe.provider.js";
import {
  assertPhonePeCredentialsForLiveCheckout,
  isPersistedMockCheckoutMode,
  paymentIntentCheckoutLabel,
  resolveDigitalMetalsCheckoutMode,
} from "./digital-metals-demo-policy.js";

export function isMockDigitalMetalsPaymentAttempt(attempt) {
  if (!attempt || !["INITIATED", "PENDING"].includes(attempt.status)) return false;
  if (attempt.checkoutMode === "LIVE") return false;
  if (isPersistedMockCheckoutMode(attempt.checkoutMode)) return true;
  return false;
}

export function mapCheckoutFieldsForPaymentIntent(attempt) {
  return {
    checkoutMode: attempt.checkoutMode ?? null,
    checkoutLabel: paymentIntentCheckoutLabel(attempt.checkoutMode),
  };
}

/**
 * @param {{ merchantOrderId: string, amountPaise: number, redirectUrl: string, credentials: object, tenantId: string, demoProviderResult: (attempt: object) => object, attempt: object }}
 */
export async function initiateDigitalMetalsPhonePeCheckout({
  merchantOrderId,
  amountPaise,
  redirectUrl,
  credentials,
  tenantId,
  demoProviderResult,
  attempt,
}) {
  const policy = resolveDigitalMetalsCheckoutMode();
  if (policy === "LIVE_REQUIRED") {
    assertPhonePeCredentialsForLiveCheckout(credentials);
    const provider = await phonePeProvider.createSdkOrder({
      merchantOrderId,
      amountPaise,
      redirectUrl,
      credentials,
      tenantId,
    });
    return { provider, checkoutMode: "LIVE" };
  }
  if (policy === "MOCK_PROVIDER") {
    const provider = {
      providerOrderId: `mock_${merchantOrderId}`,
      token: `mock-token-${merchantOrderId}`,
      status: "PENDING",
    };
    return { provider, checkoutMode: "MOCK_PROVIDER" };
  }
  if (policy === "DIGITAL_METALS_DEMO") {
    return { provider: demoProviderResult(attempt), checkoutMode: "DIGITAL_METALS_DEMO" };
  }
  throw new AppError("CHECKOUT_MODE_INVALID", "Unsupported digital metals checkout policy.", 500);
}
