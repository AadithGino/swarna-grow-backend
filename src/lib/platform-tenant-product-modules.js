import { normalizeFeatureFlags } from "../constants/platform-feature-flags.js";
import { isPlanFeatureEnabled } from "./feature-entitlements.js";
import { isEcommerceOperational } from "./ecommerce-access.js";
import { presentDigitalMetalsAccessState } from "./digital-metals-access.js";

/**
 * @typedef {'ecommerce' | 'ecommercePayments' | 'digitalMetals'} ProductModuleKey
 */

/**
 * @param {import("../models/index.js").Tenant | Record<string, unknown>} tenant
 */
export function summarizeProductModules(tenant) {
  const ecommercePlan = isPlanFeatureEnabled(tenant, "ecommerce");
  const paymentsPlan = isPlanFeatureEnabled(tenant, "ecommercePayments");
  const digitalPlan = isPlanFeatureEnabled(tenant, "digitalMetals");
  const ops = tenant?.operations ?? {};
  const shopOn = ops.ecommerceEnabled === true;
  const paymentsRollout = ops.ecommercePaymentsRolloutEnabled === true;
  const digitalOn = ops.digitalMetalsEnabled === true;
  const digital = presentDigitalMetalsAccessState(tenant);

  return {
    ecommerce: {
      planEntitled: ecommercePlan,
      tenantEnabled: shopOn,
      active: isEcommerceOperational(tenant),
      includesBooking: isEcommerceOperational(tenant),
    },
    ecommercePayments: {
      planEntitled: paymentsPlan,
      tenantRolloutEnabled: paymentsRollout,
      active: ecommercePlan && paymentsPlan && paymentsRollout,
      includesSchemeShopCheckout: ecommercePlan && paymentsPlan && paymentsRollout && shopOn,
    },
    digitalMetals: {
      planEntitled: digitalPlan,
      tenantEnabled: digitalOn,
      active: digital.active,
    },
  };
}

/**
 * @param {import("../models/index.js").Tenant | Record<string, unknown>} tenant
 * @param {{ ecommerce?: boolean, ecommercePayments?: boolean, digitalMetals?: boolean, enableAll?: boolean }} input
 */
export function patchesForProductModules(tenant, input) {
  let ecommerce = input.ecommerce;
  let ecommercePayments = input.ecommercePayments;
  let digitalMetals = input.digitalMetals;
  if (input.enableAll === true) {
    ecommerce = true;
    ecommercePayments = true;
    digitalMetals = true;
  }

  const sub = tenant?.subscription?.toObject?.() ?? tenant?.subscription ?? {};
  const featureOverrides = { ...(sub.featureOverrides ?? {}) };
  const operationsPatch = {};
  const flags = normalizeFeatureFlags(tenant?.featureFlags);

  if (ecommerce !== undefined) {
    featureOverrides.ecommerce = ecommerce === true;
    operationsPatch.ecommerceEnabled = ecommerce === true;
  }
  if (ecommercePayments !== undefined) {
    featureOverrides.ecommercePayments = ecommercePayments === true;
    operationsPatch.ecommercePaymentsRolloutEnabled = ecommercePayments === true;
    if (ecommercePayments === true) {
      flags.onlinePayments = true;
      operationsPatch.customerAppPaymentsEnabled = true;
    }
  }
  if (digitalMetals !== undefined) {
    featureOverrides.digitalMetals = digitalMetals === true;
    operationsPatch.digitalMetalsEnabled = digitalMetals === true;
  }

  return { featureOverrides, operationsPatch, featureFlags: flags };
}