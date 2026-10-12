import { EcommerceFulfilmentMode, EcommercePaymentMethod } from "../constants/enums.js";
import { AppError } from "./app-error.js";
import { isEcommerceOperational } from "./ecommerce-access.js";
import { evaluateCheckoutTaxReadiness } from "./ecommerce-checkout-tax.js";
import { mapFulfilmentSettings, normalizePincode, normalizePincodes } from "./ecommerce-fulfilment.js";
import { isPlanFeatureEnabled } from "./feature-entitlements.js";

const PINCODE_RE = /^\d{6}$/;

/**
 * Validate tenant COD pincode configuration (strict — invalid entries are rejected, not dropped).
 */
export function validateCodPincodeConfiguration({ codEnabled, codPincodes, serviceablePincodes }) {
  const errors = [];
  const serviceable = normalizePincodes(serviceablePincodes ?? []);
  const serviceableSet = new Set(serviceable);

  if (!codEnabled) {
    if (codPincodes?.length) {
      errors.push({
        field: "codPincodes",
        message: "Disable COD or remove COD pincodes.",
      });
    }
    return { ok: errors.length === 0, errors, normalized: [] };
  }

  if (!Array.isArray(codPincodes) || codPincodes.length === 0) {
    errors.push({
      field: "codPincodes",
      message: "At least one COD pincode is required when COD is enabled.",
    });
    return { ok: false, errors, normalized: [] };
  }

  const seen = new Set();
  const normalized = [];
  for (let i = 0; i < codPincodes.length; i += 1) {
    const pin = normalizePincode(codPincodes[i]);
    if (!PINCODE_RE.test(pin)) {
      errors.push({
        field: "codPincodes",
        message: `Entry ${i + 1} is not a valid 6-digit pincode.`,
      });
      continue;
    }
    if (seen.has(pin)) {
      errors.push({
        field: "codPincodes",
        message: `Duplicate pincode ${pin}.`,
      });
      continue;
    }
    seen.add(pin);
    if (!serviceableSet.has(pin)) {
      errors.push({
        field: "codPincodes",
        message: `${pin} is not in serviceable delivery pincodes.`,
      });
      continue;
    }
    normalized.push(pin);
  }

  return { ok: errors.length === 0, errors, normalized };
}

export function mapCodSettingsFromRow(row) {
  const mapped = mapFulfilmentSettings(row);
  return {
    codEnabled: row?.codEnabled === true,
    codPincodes: normalizePincodes(row?.codPincodes ?? []),
    deliveryEnabled: mapped.deliveryEnabled,
    deliveryConfigured: mapped.deliveryConfigured,
  };
}

export function isCodPincodeEligible(settingsRow, pincode) {
  const pin = normalizePincode(pincode);
  if (!PINCODE_RE.test(pin)) return false;
  const cfg = mapCodSettingsFromRow(settingsRow ?? {});
  if (!cfg.codEnabled || !cfg.deliveryEnabled) return false;
  return cfg.codPincodes.includes(pin);
}

/**
 * Server-side COD eligibility for a saved delivery address (never trust client pincode alone).
 */
export function evaluateCodEligibility({
  tenant,
  taxSettings,
  fulfilmentSettingsRow,
  fulfilmentMode,
  addressSnapshot,
}) {
  const blockers = [];
  if (fulfilmentMode !== EcommerceFulfilmentMode.DELIVERY) {
    blockers.push({
      code: "COD_DELIVERY_ONLY",
      message: "Cash on delivery is available for home delivery only.",
    });
    return { eligible: false, blockers };
  }
  if (!isEcommerceOperational(tenant)) {
    blockers.push({ code: "STORE_NOT_OPERATIONAL", message: "Online store is not active." });
  }
  if (!isPlanFeatureEnabled(tenant, "ecommerce")) {
    blockers.push({ code: "PLAN_ECOMMERCE_DISABLED", message: "Ecommerce is not on your plan." });
  }
  const tax = evaluateCheckoutTaxReadiness(taxSettings, fulfilmentSettingsRow ?? {});
  if (!tax.ready) {
    blockers.push({
      code: "CHECKOUT_TAX_NOT_READY",
      message: "Checkout tax must be configured before COD.",
    });
  }
  const mapped = mapFulfilmentSettings(fulfilmentSettingsRow ?? {});
  if (!mapped.deliveryEnabled) {
    blockers.push({ code: "DELIVERY_DISABLED", message: "Delivery is not enabled." });
  }
  const codCfg = mapCodSettingsFromRow(fulfilmentSettingsRow ?? {});
  if (!codCfg.codEnabled) {
    blockers.push({ code: "COD_DISABLED", message: "Cash on delivery is not offered." });
  }
  const pin = normalizePincode(addressSnapshot?.pincode);
  if (!addressSnapshot?.id) {
    blockers.push({ code: "ADDRESS_REQUIRED", message: "A saved delivery address is required." });
  } else if (!PINCODE_RE.test(pin)) {
    blockers.push({ code: "ADDRESS_INVALID", message: "Delivery address pincode is invalid." });
  } else if (codCfg.codEnabled && !codCfg.codPincodes.includes(pin)) {
    blockers.push({
      code: "COD_PINCODE_NOT_ELIGIBLE",
      message: "Delivery is available to this pincode, but cash on delivery is not.",
      pincode: pin,
    });
  }
  return { eligible: blockers.length === 0, blockers, codPincode: pin };
}

export function resolveQuotePaymentMethod(body) {
  const raw = String(body?.paymentMethod ?? EcommercePaymentMethod.ONLINE).trim().toUpperCase();
  if (raw === EcommercePaymentMethod.COD) return EcommercePaymentMethod.COD;
  return EcommercePaymentMethod.ONLINE;
}

export function assertQuotePaymentMethodAllowed(paymentMethod, codEvaluation) {
  if (paymentMethod === EcommercePaymentMethod.ONLINE) return;
  if (!codEvaluation.eligible) {
    throw new AppError(
      "COD_NOT_AVAILABLE",
      "Cash on delivery is not available for this checkout.",
      422,
      { blockers: codEvaluation.blockers },
    );
  }
}

export function derivePaymentMethodOptions({ capability, codEvaluation }) {
  const online = {
    method: EcommercePaymentMethod.ONLINE,
    eligible: capability.paymentAllowed === true,
    blockers: capability.paymentAllowed
      ? []
      : (capability.blockers ?? []).filter(Boolean),
  };
  const cod = {
    method: EcommercePaymentMethod.COD,
    eligible: codEvaluation.eligible === true,
    blockers: codEvaluation.blockers ?? [],
  };
  return {
    paymentMethods: [online, cod],
    orderPlacement: {
      [EcommercePaymentMethod.ONLINE]: online.eligible,
      [EcommercePaymentMethod.COD]: cod.eligible,
    },
  };
}

export function orderUsesCod(row) {
  return (row?.paymentMethod ?? EcommercePaymentMethod.ONLINE) === EcommercePaymentMethod.COD;
}
