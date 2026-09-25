/**
 * Ensures at least one PENDING cash handover exists for KAIRALI (tenant portal accept/reject E2E).
 * Safe to run repeatedly — skips when a pending handover already exists for the tenant.
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  CashHandoverStatus,
  HandoverInitiator,
  PaymentMode,
  UserStatus,
} from "../src/constants/enums.js";
import { CashHandover, Scheme, Tenant, User } from "../src/models/index.js";
import { createHandover, cashBalance } from "../src/services/cash.service.js";
import { recordPayment } from "../src/services/payment.service.js";

function staffReq(user, tenantId, branchId, extra = {}) {
  return {
    auth: {
      id: user._id,
      tenantId,
      type: "TENANT_USER",
      role: user.role,
      ...(branchId ? { branchId } : {}),
    },
    scope: { tenantId, ...(branchId ? { branchId } : {}) },
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "seed-pending-handover" },
    ip: "127.0.0.1",
    query: {},
    body: {},
    ...extra,
  };
}

async function main() {
  await connectDatabase();
  const tenant = await Tenant.findOne({ code: "KAIRALI" }).lean();
  if (!tenant) throw new Error("KAIRALI tenant not found");

  const pending = await CashHandover.countDocuments({
    tenantId: tenant._id,
    status: CashHandoverStatus.PENDING,
  });
  if (pending > 0) {
    console.log(
      JSON.stringify({ ok: true, skipped: true, pendingCount: pending }, null, 2),
    );
    await disconnectDatabase();
    return;
  }

  const staff = await User.findOne({
    tenantId: tenant._id,
    status: UserStatus.ACTIVE,
    role: { $in: ["BRANCH_MANAGER", "BRANCH_STAFF", "COLLECTION_AGENT"] },
  })
    .sort({ role: 1 })
    .lean();
  if (!staff) throw new Error("No active staff for KAIRALI");

  const branchId = staff.branchId;
  let balance = await cashBalance({
    tenantId: tenant._id,
    branchId,
    staffId: staff._id,
  });

  const targetPaise = 25_000;
  if (balance.availableForHandoverPaise < targetPaise) {
    const scheme = await Scheme.findOne({
      tenantId: tenant._id,
      branchId,
      status: { $in: ["ACTIVE", "LOCKED"] },
    })
      .sort({ updatedAt: -1 })
      .lean();
    if (!scheme) {
      throw new Error(
        "No cash in hand and no active scheme to record a seed payment against",
      );
    }
    const need = targetPaise - balance.availableForHandoverPaise + 5_000;
    await recordPayment(
      staffReq(staff, tenant._id, branchId, {
        params: { schemeId: scheme._id },
        body: {
          amountPaise: need,
          mode: PaymentMode.CASH,
          expectedVersion: scheme.version,
          remarks: "Seed cash for pending handover E2E",
        },
      }),
    );
    balance = await cashBalance({
      tenantId: tenant._id,
      branchId,
      staffId: staff._id,
    });
  }

  const amountPaise = Math.min(
    targetPaise,
    balance.availableForHandoverPaise,
  );
  if (amountPaise < 1_000) {
    throw new Error(
      `Staff ${staff.name} has insufficient cash in hand (${balance.availableForHandoverPaise} paise)`,
    );
  }

  const row = await createHandover(
    staffReq(staff, tenant._id, branchId, {
      body: {
        amountPaise,
        remarks: "E2E seed — pending handover for Cash control accept/reject",
      },
    }),
    HandoverInitiator.STAFF,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        handoverId: row._id,
        staffId: staff._id,
        staffName: staff.name,
        amountPaise,
        status: CashHandoverStatus.PENDING,
      },
      null,
      2,
    ),
  );
  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
