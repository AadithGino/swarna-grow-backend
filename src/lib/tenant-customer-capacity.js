import { Customer } from "../models/index.js";
import { CustomerStatus } from "../constants/enums.js";
import { AppError } from "./app-error.js";
import { subscriptionLimit } from "./tenant-limits.js";

async function seedActiveCustomerCounter(tenantId, session) {
  const used = await Customer.countDocuments({
    tenantId,
    status: CustomerStatus.ACTIVE,
  }).session(session);
  const { Tenant } = await import("../models/index.js");
  await Tenant.findOneAndUpdate(
    { _id: tenantId },
    {
      $set: {
        usageCounters: {
          activeCustomers: used,
          activeCustomersSeededAt: new Date(),
        },
      },
    },
    { session },
  );
  return used;
}

/**
 * Atomically reserves one active-customer seat. Must run in the same transaction as customer create / ACTIVE transition.
 */
export async function reserveActiveCustomerSeat(tenant, session) {
  const limit = subscriptionLimit(tenant, "activeCustomers");
  if (limit == null) return;

  const tenantId = tenant._id ?? tenant.id;
  const { Tenant } = await import("../models/index.js");

  const current = await Tenant.findById(tenantId)
    .select("usageCounters")
    .session(session)
    .lean();
  if (
    current?.usageCounters?.activeCustomers == null
    || typeof current?.usageCounters?.activeCustomers !== "number"
  ) {
    await seedActiveCustomerCounter(tenantId, session);
  }

  const row = await Tenant.findOneAndUpdate(
    {
      _id: tenantId,
      $expr: {
        $lt: [{ $ifNull: ["$usageCounters.activeCustomers", 0] }, limit],
      },
    },
    {
      $inc: { "usageCounters.activeCustomers": 1 },
      $set: { "usageCounters.activeCustomersSeededAt": new Date() },
    },
    { session, new: true },
  );

  if (!row) {
    const used = await Customer.countDocuments({
      tenantId,
      status: CustomerStatus.ACTIVE,
    }).session(session);
    throw new AppError(
      "LIMIT_CUSTOMERS",
      `Your plan allows ${limit} active customers.`,
      403,
      { limit, used },
    );
  }
}

export async function releaseActiveCustomerSeat(tenantId, session) {
  const { Tenant } = await import("../models/index.js");
  await Tenant.findOneAndUpdate(
    { _id: tenantId, "usageCounters.activeCustomers": { $gt: 0 } },
    { $inc: { "usageCounters.activeCustomers": -1 } },
    { session },
  );
}
