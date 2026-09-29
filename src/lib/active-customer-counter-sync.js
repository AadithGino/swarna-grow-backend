import { Customer, Tenant } from "../models/index.js";
import { CustomerStatus } from "../constants/enums.js";
import { withTransientTransactionRetry } from "./transaction.js";

export async function countActiveCustomersForTenant(tenantId, session = null) {
  const q = Customer.countDocuments({
    tenantId,
    status: CustomerStatus.ACTIVE,
  });
  if (session) q.session(session);
  return q;
}

/**
 * Reconcile tenant.usageCounters.activeCustomers to the ACTIVE customer count.
 * Must run inside a transaction so concurrent seat reserve/release on the same tenant doc can conflict.
 */
export async function syncActiveCustomerCounterInSession(session, tenantId) {
  await Tenant.findById(tenantId).select("_id usageCounters").session(session);
  const actual = await countActiveCustomersForTenant(tenantId, session);
  await Tenant.updateOne(
    { _id: tenantId },
    {
      $set: {
        "usageCounters.activeCustomers": actual,
        "usageCounters.activeCustomersSeededAt": new Date(),
      },
    },
    { session },
  );
  return actual;
}

export async function syncActiveCustomerCounterForTenant(tenantId, { maxAttempts = 5 } = {}) {
  return withTransientTransactionRetry(
    (session) => syncActiveCustomerCounterInSession(session, tenantId),
    { maxAttempts },
  );
}

export async function parityForTenant(tenantLean) {
  const stored = tenantLean.usageCounters?.activeCustomers;
  const storedNum = typeof stored === "number" ? stored : null;
  const actual = await countActiveCustomersForTenant(tenantLean._id);
  const delta = storedNum == null ? actual : actual - storedNum;
  return {
    tenantId: tenantLean._id,
    code: tenantLean.code ?? tenantLean._id,
    stored: storedNum,
    actual,
    delta,
    inSync: storedNum === actual,
  };
}

export async function verifyAllTenantsInSync() {
  const tenants = await Tenant.find({}).select("_id code usageCounters").lean();
  const rows = [];
  for (const tenant of tenants) {
    const row = await parityForTenant(tenant);
    if (!row.inSync) rows.push(row);
  }
  return rows;
}
