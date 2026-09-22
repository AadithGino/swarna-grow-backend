/**
 * Ensures KAIRALI has records for tenant UI parity actions that often skip when empty:
 * - at least one DRAFT scheme plan (activate in UI)
 * - one SUCCESS CASH payment tagged for reverse E2E
 * - one APPROVED redemption (reject in UI) when a matured scheme exists
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  PaymentMode,
  PaymentStatus,
  RedemptionMode,
  RedemptionStatus,
  SchemePlanStatus,
  SchemeStatus,
  UserStatus,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import {
  Payment,
  Redemption,
  Scheme,
  SchemePlan,
  Tenant,
  User,
} from "../src/models/index.js";
import { recordPayment } from "../src/services/payment.service.js";
import {
  initiateRedemption,
  transitionRedemption,
} from "../src/services/redemption.service.js";

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
    headers: { "user-agent": "seed-tenant-coverage-gaps" },
    ip: "127.0.0.1",
    query: {},
    body: {},
    ...extra,
  };
}

async function ensureDraftPlan(tenantId) {
  const existing = await SchemePlan.findOne({
    tenantId,
    status: SchemePlanStatus.DRAFT,
  }).lean();
  if (existing) return { draftPlanId: existing._id, created: false };

  const template = await SchemePlan.findOne({
    tenantId,
    status: SchemePlanStatus.ACTIVE,
  }).lean();
  if (!template) return { draftPlanId: null, created: false };

  const suffix = String(Date.now()).slice(-5);
  const {
    _id: _templateId,
    code: _templateCode,
    createdAt: _templateCreatedAt,
    updatedAt: _templateUpdatedAt,
    ...rest
  } = template;
  const row = await SchemePlan.create({
    ...rest,
    _id: createId("spl"),
    code: `E2E${suffix}`,
    name: `E2E Draft ${suffix}`,
    displayName: `E2E Draft ${suffix}`,
    status: SchemePlanStatus.DRAFT,
  });
  return { draftPlanId: row._id, created: true };
}

async function ensureReversePaymentSeed(tenantId, owner) {
  const tagged = await Payment.findOne({
    tenantId,
    status: PaymentStatus.SUCCESS,
    mode: PaymentMode.CASH,
    remarks: /E2E reverse seed/i,
  }).lean();
  if (tagged) return { paymentId: tagged._id, created: false };

  const scheme = await Scheme.findOne({
    tenantId,
    status: { $in: [SchemeStatus.ACTIVE, SchemeStatus.LOCKED] },
  })
    .sort({ updatedAt: -1 })
    .lean();
  if (!scheme) return { paymentId: null, created: false };

  const actor =
    (await User.findOne({
      tenantId,
      branchId: scheme.branchId,
      status: UserStatus.ACTIVE,
      role: { $in: ["TENANT_OWNER", "BRANCH_MANAGER", "BRANCH_STAFF"] },
    }).lean()) ?? owner;

  const fresh = await Scheme.findById(scheme._id).lean();
  const payment = await recordPayment(
    staffReq(actor, tenantId, scheme.branchId, {
      body: {
        schemeId: fresh._id,
        amountPaise: 10_000,
        mode: PaymentMode.CASH,
        expectedVersion: fresh.version,
        remarks: "E2E reverse seed",
      },
    }),
  );
  return { paymentId: payment._id ?? payment.id, created: true };
}

async function ensureApprovedRedemption(tenantId, owner, branchId) {
  const approved = await Redemption.findOne({
    tenantId,
    status: RedemptionStatus.APPROVED,
  }).lean();
  if (approved) return { redemptionId: approved._id, created: false };

  const matured = await Scheme.findOne({
    tenantId,
    status: SchemeStatus.MATURED,
  }).lean();
  if (!matured) return { redemptionId: null, created: false };

  const open = await Redemption.findOne({
    tenantId,
    schemeId: matured._id,
    status: {
      $in: [
        RedemptionStatus.REQUESTED,
        RedemptionStatus.PENDING_APPROVAL,
        RedemptionStatus.APPROVED,
      ],
    },
  }).lean();
  if (open?.status === RedemptionStatus.APPROVED) {
    return { redemptionId: open._id, created: false };
  }

  const base = staffReq(owner, tenantId, branchId ?? matured.branchId, {
    params: { schemeId: matured._id },
    scope: { tenantId, branchId: matured.branchId },
  });

  let redemptionId = open?._id;
  if (!redemptionId) {
    const created = await initiateRedemption({
      ...base,
      body: { mode: RedemptionMode.CASH },
    });
    redemptionId = created._id ?? created.id;
  }

  await transitionRedemption(
    staffReq(owner, tenantId, matured.branchId, {
      params: { redemptionId, id: redemptionId },
      scope: { tenantId, branchId: matured.branchId },
      body: {},
    }),
    "approve",
  );
  return { redemptionId, created: true };
}

async function main() {
  await connectDatabase();
  const tenant = await Tenant.findOne({ code: "KAIRALI" }).lean();
  if (!tenant) throw new Error("KAIRALI tenant not found");

  const owner = await User.findOne({
    tenantId: tenant._id,
    role: "TENANT_OWNER",
    status: UserStatus.ACTIVE,
  }).lean();
  if (!owner) throw new Error("KAIRALI owner not found");

  const branchId =
    owner.branchId ??
    (
      await User.findOne({
        tenantId: tenant._id,
        status: UserStatus.ACTIVE,
        branchId: { $exists: true, $ne: null },
      }).lean()
    )?.branchId;

  const draft = await ensureDraftPlan(tenant._id);
  const payment = await ensureReversePaymentSeed(tenant._id, owner).catch((err) => ({
    error: String(err?.message ?? err),
  }));
  const redemption = await ensureApprovedRedemption(tenant._id, owner, branchId).catch(
    (err) => ({ error: String(err?.message ?? err) }),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        draft,
        reversePayment: payment,
        approvedRedemption: redemption,
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
