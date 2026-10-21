import { DigitalMetalAccessMarker } from "../models/index.js";

const KINDS = Object.freeze(["HOLDINGS", "SETTLEMENT", "FULFILMENT"]);

export async function tenantHasDigitalMetalLegacyActivity(tenantId) {
  if (!tenantId) return false;
  return Boolean(await DigitalMetalAccessMarker.exists({ tenantId }));
}

export async function customerHasDigitalMetalLegacyAccess(tenantId, customerId) {
  if (!tenantId || !customerId) {
    return { any: false, kinds: [] };
  }
  const row = await DigitalMetalAccessMarker.findOne({ tenantId, customerId }).lean();
  if (!row) return { any: false, kinds: [] };
  const kinds = (row.kinds ?? []).filter((k) => KINDS.includes(k));
  return { any: kinds.length > 0, kinds };
}
