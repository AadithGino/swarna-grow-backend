import { EcommerceFulfilmentMode } from "../constants/enums.js";
import { AppError } from "./app-error.js";

const PINCODE_RE = /^\d{6}$/;

export function normalizePincode(raw) {
  return String(raw ?? "").trim();
}

export function normalizePincodes(list = []) {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const pin = normalizePincode(raw);
    if (!PINCODE_RE.test(pin)) continue;
    if (seen.has(pin)) continue;
    seen.add(pin);
    out.push(pin);
  }
  return out;
}

export function deriveDeliveryConfigured(settings) {
  const pincodes = normalizePincodes(settings?.serviceablePincodes ?? []);
  const charge = settings?.deliveryChargePaise;
  return (
    pincodes.length > 0
    && charge != null
    && Number.isInteger(charge)
    && charge >= 0
  );
}

export function mapFulfilmentSettings(row) {
  const deliveryConfigured = deriveDeliveryConfigured(row);
  const deliveryEnabled = row?.deliveryEnabled === true && deliveryConfigured;
  return {
    id: row?._id ?? null,
    pickupEnabled: row?.pickupEnabled === true,
    pickupBranchIds: row?.pickupBranchIds ?? [],
    deliveryEnabled,
    deliveryConfigured,
    deliveryChargePaise: row?.deliveryChargePaise ?? null,
    serviceablePincodes: normalizePincodes(row?.serviceablePincodes ?? []),
    maxCartLines: row?.maxCartLines ?? 50,
    maxQuantityPerLine: row?.maxQuantityPerLine ?? 99,
    checkoutTaxConfig: row?.checkoutTaxConfig ?? {},
    version: row?.version ?? 1,
  };
}

export function assertFulfilmentSelection(settings, { mode, pickupBranchId, pincode }) {
  if (mode === EcommerceFulfilmentMode.BRANCH_PICKUP) {
    if (!settings?.pickupEnabled) {
      throw new AppError("FULFILMENT_UNAVAILABLE", "Branch pickup is not enabled.", 422);
    }
    const allowed = new Set(settings.pickupBranchIds ?? []);
    if (!pickupBranchId || !allowed.has(pickupBranchId)) {
      throw new AppError("FULFILMENT_UNAVAILABLE", "Selected pickup branch is not available.", 422);
    }
    return { fulfilmentChargePaise: 0 };
  }
  if (mode === EcommerceFulfilmentMode.DELIVERY) {
    if (!settings?.deliveryEnabled) {
      throw new AppError("FULFILMENT_UNAVAILABLE", "Delivery is not available.", 422);
    }
    const pin = normalizePincode(pincode);
    if (!PINCODE_RE.test(pin)) {
      throw new AppError("VALIDATION_FAILED", "A valid 6-digit pincode is required.", 422);
    }
    const serviceable = new Set(settings.serviceablePincodes ?? []);
    if (!serviceable.has(pin)) {
      throw new AppError("FULFILMENT_UNAVAILABLE", "Delivery is not serviceable for this pincode.", 422);
    }
    return { fulfilmentChargePaise: settings.deliveryChargePaise ?? 0 };
  }
  throw new AppError("VALIDATION_FAILED", "Unknown fulfilment mode.", 422);
}

export function customerFulfilmentOptions(settings, branches = []) {
  const mapped = mapFulfilmentSettings(settings);
  const pickupBranchSet = new Set(mapped.pickupBranchIds);
  return {
    pickup: mapped.pickupEnabled
      ? {
          enabled: true,
          branches: branches
            .filter((b) => pickupBranchSet.has(b.id ?? b._id))
            .map((b) => ({
              id: b.id ?? b._id,
              name: b.name,
              code: b.code,
            })),
        }
      : { enabled: false, branches: [] },
    delivery: mapped.deliveryEnabled
      ? {
          enabled: true,
          serviceablePincodes: mapped.serviceablePincodes,
          deliveryChargePaise: mapped.deliveryChargePaise,
        }
      : { enabled: false, serviceablePincodes: [], deliveryChargePaise: null },
    checkoutUsable: false,
  };
}
