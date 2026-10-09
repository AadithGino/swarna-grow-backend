import { env } from "../config/env.js";
import { errors } from "./app-error.js";
import { evaluateCheckoutTaxReadiness } from "./ecommerce-checkout-tax.js";
import { isEcommerceOperational } from "./ecommerce-access.js";
import { allowTestEcommercePayments } from "./ecommerce-test-harness.js";
import { assertPlatformCapability } from "./feature-entitlements.js";
import { isPlanFeatureEnabled } from "./feature-entitlements.js";
import { resolvePhonePeCredentials } from "../integrations/phonepe.provider.js";
import { customerAppPaymentsEnabled } from "./customer-app-access.js";

function gatewayConfigured(tenant) {
  try {
    const credentials = resolvePhonePeCredentials(tenant);
    return Boolean(credentials?.clientId && credentials?.clientSecret);
  } catch {
    return false;
  }
}

function platformRolloutEnabled() {
  return env.ECOMMERCE_PAYMENTS_ROLLOUT_ENABLED === true;
}

function tenantRolloutEnabled(tenant) {
  return tenant?.operations?.ecommercePaymentsRolloutEnabled === true;
}

/**
 * Derived checkout/payment capability. `paymentAllowed` is never equal to `checkoutTaxReady`.
 */
export function deriveEcommerceCheckoutCapability({
  taxSettings,
  fulfilmentSettingsRow,
  tenant,
}) {
  const tax = evaluateCheckoutTaxReadiness(taxSettings, fulfilmentSettingsRow ?? {});
  const storeOperational = isEcommerceOperational(tenant);
  const blockers = [...tax.blockers];

  if (!storeOperational) {
    blockers.push({ code: "STORE_NOT_OPERATIONAL", message: "Online store is not active." });
  }
  if (!isPlanFeatureEnabled(tenant, "ecommerce")) {
    blockers.push({ code: "PLAN_ECOMMERCE_DISABLED", message: "Ecommerce is not on your plan." });
  }
  if (!isPlanFeatureEnabled(tenant, "ecommercePayments")) {
    blockers.push({
      code: "PLAN_ECOMMERCE_PAYMENTS_DISABLED",
      message: "Ecommerce payments are not on your plan.",
    });
  }
  if (!customerAppPaymentsEnabled(tenant)) {
    blockers.push({
      code: "CUSTOMER_PAYMENTS_DISABLED",
      message: "Customer online payments are disabled for this store.",
    });
  }
  if (!gatewayConfigured(tenant)) {
    blockers.push({
      code: "PAYMENT_GATEWAY_NOT_CONFIGURED",
      message: "Payment gateway is not configured.",
    });
  }
  if (!platformRolloutEnabled()) {
    blockers.push({
      code: "ECOMMERCE_PAYMENTS_ROLLOUT_OFF",
      message: "Ecommerce payments rollout is not enabled on the platform.",
    });
  }
  if (!tenantRolloutEnabled(tenant)) {
    blockers.push({
      code: "TENANT_ECOMMERCE_PAYMENTS_ROLLOUT_OFF",
      message: "Ecommerce payments are not enabled for this jeweller.",
    });
  }

  const paymentsReady =
    tax.ready
    && storeOperational
    && isPlanFeatureEnabled(tenant, "ecommerce")
    && isPlanFeatureEnabled(tenant, "ecommercePayments")
    && customerAppPaymentsEnabled(tenant)
    && gatewayConfigured(tenant)
    && platformRolloutEnabled()
    && tenantRolloutEnabled(tenant);

  const paymentAllowed = paymentsReady || allowTestEcommercePayments();

  return {
    checkoutTaxReady: tax.ready,
    checkoutUsable: paymentAllowed,
    paymentAllowed,
    paymentCompleted: false,
    storeOperational,
    blockers,
    taxPresentation: tax.presentation,
  };
}

/** Both tax readiness and gateway/payment capability must pass before charging. */
export function assertCheckoutChargingAllowed(capability) {
  if (!capability.checkoutTaxReady) {
    throw errors.business(
      "CHECKOUT_NOT_READY",
      "Checkout tax and place-of-supply must be configured before placing an order or paying.",
      { checkoutTaxReady: false, blockers: capability.blockers },
    );
  }
  if (!capability.paymentAllowed) {
    throw errors.business(
      "PAYMENT_NOT_AVAILABLE",
      "Checkout payment is not available for this store.",
      { checkoutTaxReady: capability.checkoutTaxReady, blockers: capability.blockers },
    );
  }
}

export function assertCustomerOrderCreationAllowed(capability) {
  assertCheckoutChargingAllowed(capability);
}

export function assertCustomerPaymentAllowed(capability) {
  assertCheckoutChargingAllowed(capability);
}

export function assertEcommercePaymentEntitlements(tenant) {
  assertPlatformCapability(tenant, "onlinePayments");
}
