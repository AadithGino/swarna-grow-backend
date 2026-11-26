/**
 * Live cutover: replace misconfigured AIRAUPFRONT catalog plan with buildAiraUpfrontPlan rules.
 * Does not wipe schemes; deactivates the old plan and frees the code via AIRAUPFRONT_LEGACY rename.
 *
 *   AIRA_TENANT_ID=tnt_... node --env-file=.env scripts/rollout-aira-upfront-plan.js
 *   AIRA_TENANT_CODE=AIRA node --env-file=.env scripts/rollout-aira-upfront-plan.js  # resolves tenant id by code
 *   npm run rollout:aira-upfront
 */
import process from "node:process";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { SchemePlanStatus, TenantRole, UserType } from "../src/constants/enums.js";
import { mapCustomerPlanListItem } from "../src/lib/customer-app-dto.js";
import { validateCompletePlan } from "../src/lib/plan-merge.js";
import { buildAiraUpfrontPlan } from "./lib/collection-gold-plan-seed.js";
import { createPlan, setPlanStatus, previewSchedule } from "../src/services/plan.service.js";
import { Scheme, SchemePlan, Tenant, User } from "../src/models/index.js";
import { previewScheduleBody } from "../src/validators/common.validators.js";

const ALLOWED_TENANT_CODES = new Set(["AIRAGOLD", "AIRA"]);
const EXAMPLE_PLAN_ID = "spl_onetime_aira_example";
const TARGET_CODE = "AIRAUPFRONT";
const LEGACY_CODE = "AIRAUPFRONT_LEGACY";
const MAX_UPFRONT_PAISE = Number(process.env.AIRA_UPFRONT_MAX_PAISE ?? 50_000_000);

const ONETIME7_OK = {
  code: "ONETIME7",
  fixedAmountPaise: 6_000_000,
  durationMonths: 3,
  installmentCount: 1,
  bonusValue: 7,
};

function makeReq(tenant, user) {
  return {
    auth: { id: user._id, tenantId: tenant._id, type: UserType.TENANT_USER, role: user.role },
    scope: { tenantId: tenant._id },
    tenant: tenant.toObject ? tenant.toObject() : tenant,
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "rollout-aira-upfront" },
    ip: "127.0.0.1",
    body: {},
    query: {},
    params: {},
  };
}

function rulesMatchUpfront(plan) {
  const rules = plan.oneTimeRules;
  return (
    plan.installmentCount === 1
    && plan.durationMonths === 12
    && rules?.timing === "MONTHLY"
    && rules?.basis === "PRINCIPAL_PERCENT"
    && rules?.value === 2
    && rules?.amountPeriod === "PER_PERIOD"
    && plan.amountRules?.minInstallmentPaise === 10_000_000
    && plan.amountRules?.maxInstallmentPaise === MAX_UPFRONT_PAISE
    && !plan.collectionRules
    && plan.status === SchemePlanStatus.ACTIVE
  );
}

async function verifyExamplePlan(tenantId) {
  const byId = await SchemePlan.findOne({ _id: EXAMPLE_PLAN_ID, tenantId }).lean();
  if (!byId) {
    console.log(`No example plan ${EXAMPLE_PLAN_ID} in tenant — skip ONETIME7 deactivation.`);
    return null;
  }
  const ok =
    byId.code === ONETIME7_OK.code
    && byId.amountRules?.fixedAmountPaise === ONETIME7_OK.fixedAmountPaise
    && byId.durationMonths === ONETIME7_OK.durationMonths
    && byId.installmentCount === ONETIME7_OK.installmentCount;
  if (!ok) {
    throw new Error(
      `Example plan ${EXAMPLE_PLAN_ID} does not match ONETIME7 rules in this environment — stop cutover.`,
    );
  }
  return byId;
}

async function resolveRolloutTenantId() {
  const explicit = process.env.AIRA_TENANT_ID?.trim();
  if (explicit) return explicit;
  const code = (process.env.AIRA_TENANT_CODE ?? "AIRAGOLD").trim().toUpperCase();
  const byCode = await Tenant.findOne({ code }).select("_id code").lean();
  if (!byCode) throw new Error(`Tenant code ${code} not found — set AIRA_TENANT_ID.`);
  return byCode._id;
}

async function main() {
  await connectDatabase();

  const tenantId = await resolveRolloutTenantId();
  const tenant = await Tenant.findById(tenantId);
  if (!tenant || !ALLOWED_TENANT_CODES.has(tenant.code)) {
  throw new Error(
      `Tenant ${tenantId} code ${tenant?.code ?? "?"} is not in ${[...ALLOWED_TENANT_CODES].join(", ")} — stop cutover until identified.`,
    );
  }
  console.log(`Rollout tenant: ${tenant.code} (${tenantId})`);

  const owner =
    (await User.findOne({ tenantId, role: TenantRole.TENANT_OWNER, status: "ACTIVE" }).lean())
    ?? (await User.findOne({ tenantId, type: UserType.TENANT_USER, status: "ACTIVE" }).lean());
  if (!owner) throw new Error("No tenant admin user for rollout context.");

  const req = makeReq(tenant, owner);

  const example = await verifyExamplePlan(tenantId);
  if (example && example.status === SchemePlanStatus.ACTIVE) {
    req.params = { planId: example._id };
    const deactivated = await setPlanStatus(req, SchemePlanStatus.INACTIVE);
    console.log(`Deactivated example plan ${example._id} → ${deactivated.status}`);
  }

  const existingUpfront = await SchemePlan.findOne({ tenantId, code: TARGET_CODE }).lean();
  if (existingUpfront && rulesMatchUpfront(existingUpfront)) {
    console.log(`Catalog already has matching ACTIVE ${TARGET_CODE} (${existingUpfront._id}) — no change.`);
    await printCatalogChecks(tenantId, existingUpfront._id);
    await disconnectDatabase();
    return;
  }

  if (existingUpfront) {
    console.log(
      `Existing ${TARGET_CODE} ${existingUpfront._id} differs (installmentCount=${existingUpfront.installmentCount}, oneTimeRules=${JSON.stringify(existingUpfront.oneTimeRules ?? null)}).`,
    );
    const enrolments = await Scheme.countDocuments({ tenantId, planId: existingUpfront._id });
    console.log(`Preserving ${enrolments} scheme(s) on snapshots; deactivating catalog plan.`);

    req.params = { planId: existingUpfront._id };
    await setPlanStatus(req, SchemePlanStatus.INACTIVE);

    const legacyTaken = await SchemePlan.exists({ tenantId, code: LEGACY_CODE });
    const legacyCode = legacyTaken
      ? `${LEGACY_CODE}_${Date.now().toString(36).slice(-4).toUpperCase()}`
      : LEGACY_CODE;
    await SchemePlan.updateOne(
      { _id: existingUpfront._id, tenantId },
      { $set: { code: legacyCode }, $inc: { version: 1 } },
    );
    console.log(`Renamed inactive plan code → ${legacyCode}`);
  }

  const body = validateCompletePlan(buildAiraUpfrontPlan({ maximumUpfrontPaise: MAX_UPFRONT_PAISE }));
  req.body = body;
  const created = await createPlan(req);
  console.log(`Created ${TARGET_CODE} plan ${created._id ?? created.id}`);

  const planId = created._id ?? created.id;
  const preview = await previewSchedule(
    previewScheduleBody.parse({
      ...body,
      planId,
      startDate: "2028-01-15",
      installmentAmountPaise: 10_000_000,
      firstInstallmentMode: "COLLECT_NOW",
    }),
    tenantId,
  );
  console.log("Preview check:", {
    scheduleRows: preview.schedule.length,
    oneTimePeriods: preview.summary.oneTimeSchedule?.length ?? 0,
    totalPayable: preview.summary.totalPayable?.amountPaise,
    maturityDate: preview.summary.maturityDate,
  });
  if (preview.schedule.length !== 1 || (preview.summary.oneTimeSchedule?.length ?? 0) !== 12) {
    throw new Error("Preview schedule failed acceptance checks.");
  }

  await printCatalogChecks(tenantId, planId);
  console.log("\nRollout complete.");
}

async function printCatalogChecks(tenantId, newPlanId) {
  const activePlans = await SchemePlan.find({
    tenantId,
    status: SchemePlanStatus.ACTIVE,
    "availability.visibleInCustomerApp": true,
  }).lean();
  const customerItems = activePlans.map(mapCustomerPlanListItem);
  const upfront = customerItems.find((row) => row.code === TARGET_CODE);
  const legacyVisible = customerItems.some((row) => row.code.startsWith("AIRAUPFRONT_LEG"));
  console.log("\nCustomer catalog (active, visible):");
  for (const row of customerItems) {
    console.log(`  · ${row.code} — ${row.paymentPatternLabel} — ${row.displayName}`);
  }
  if (!upfront) throw new Error(`${TARGET_CODE} missing from customer catalog.`);
  if (upfront.id !== newPlanId) throw new Error("Customer catalog points at unexpected plan id.");
  if (legacyVisible) console.warn("Warning: legacy AIRAUPFRONT code still visible — check availability.");
  if (upfront.paymentPatternLabel !== "One upfront payment") {
    throw new Error(`Expected paymentPatternLabel "One upfront payment", got ${upfront.paymentPatternLabel}`);
  }
  const openOnLegacy = await Scheme.countDocuments({
    tenantId,
    planId: { $ne: newPlanId },
    status: { $in: ["PENDING_PAYMENT", "ACTIVE", "LOCKED", "DEFAULTED", "MATURED"] },
    "planSnapshot.code": TARGET_CODE,
  });
  console.log(`Open/matured schemes still on old ${TARGET_CODE} snapshots: ${openOnLegacy} (expected ≥0, preserved).`);
}

main()
  .then(() => disconnectDatabase())
  .catch(async (error) => {
    console.error(error.message ?? error);
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  });