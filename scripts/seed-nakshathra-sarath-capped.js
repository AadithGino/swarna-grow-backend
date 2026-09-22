/**
 * Reseed Nakshathra Jewellers · Sarath (ENR-0000002) into CAPPED phase with
 * six free-window months of multi-payments each, for local capped-amount testing.
 *
 * Usage: node --env-file=.env scripts/seed-nakshathra-sarath-capped.js
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { FlexiblePhase, SchemeStatus, UserType } from "../src/constants/enums.js";
import { addMonthsClamped, monthKey, today } from "../src/lib/date.js";
import {
  LedgerEntry,
  Payment,
  PaymentIntent,
  PaymentLink,
  Scheme,
  Tenant,
  User,
} from "../src/models/index.js";
import { recordPayment } from "../src/services/payment.service.js";
import { buildSchedulePreview } from "../src/services/schedule.service.js";
import { applyFlexibleLock } from "../src/services/scheme.service.js";

const SCHEME_ID = "sch_01M33R4NK7BGPJ32GGJKRFPJEH";
const TENANT_ID = "tnt_01M33NZ7JMR9ABR5MCP306YQN7";
const OWNER_USER_ID = "usr_01M33NZ7JXH0PYZJEJESYQHFHT";

/** START_NEXT_CYCLE + 7 months back → 6 free cycles ending Aug; Sep is first capped. */
const SCHEME_START = addMonthsClamped(today(), -7).format("YYYY-MM-DD");

function makeOwnerCtx(tenant, user) {
  return {
    auth: {
      id: user._id,
      tenantId: tenant._id,
      type: UserType.TENANT_USER,
      role: user.role,
    },
    scope: { tenantId: tenant._id },
    tenant,
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "seed-nakshathra-sarath-capped" },
    ip: "127.0.0.1",
    body: {},
    query: {},
  };
}

function flexCycleReferenceDate(cycleKey) {
  return `${cycleKey}-15`;
}

function flexPaymentReq(ctx, schemeId, { amountPaise, expectedPositionVersion, mode = "CASH", targetCycle }) {
  return {
    ...ctx,
    body: {
      schemeId,
      amountPaise,
      mode,
      targetCycle,
      expectedPositionVersion,
    },
    query: { targetCycle },
  };
}

async function recordFlexPayment(ctx, schemeId, amountPaise, targetCycle, mode = "CASH") {
  const doc = await Scheme.findById(schemeId);
  const referenceDate = flexCycleReferenceDate(targetCycle);
  await recordPayment(
    flexPaymentReq(ctx, doc._id, {
      amountPaise,
      expectedPositionVersion: doc.positionVersion ?? 0,
      mode,
      targetCycle,
    }),
    {
      // referenceDate: payable-range / targetCycle validation only (see payment-reference-date-override.js)
      referenceDate,
      internalReferenceDateOverride: true,
      paidAt: new Date(`${referenceDate}T12:00:00.000Z`),
    },
  );
}

function buildFreshCycles(planSnapshot, startDate) {
  const firstInstallmentMode = "START_NEXT_CYCLE";
  return buildSchedulePreview({
    startDate,
    durationMonths: planSnapshot.durationMonths,
    installmentCount: planSnapshot.durationMonths,
    scheduleRules: planSnapshot.scheduleRules ?? {},
    firstInstallmentMode,
  }).map((row) => ({
    cycle: row.dueDate.slice(0, 7),
    capPaise: 0,
    paidPaise: 0,
    remainingPaise: 0,
    status: "UPCOMING",
    expiresAt: row.graceEndsAt,
  }));
}

/** Three payments per free month (varied amounts, all ≥ min payment rules). */
/** ₹2,000 × 3 × 6 free months → cap ₹2,000/mo (fits plan capped min ₹1,000 for split payments). */
const FREE_MONTH_PAYMENTS = [
  [200_000, 200_000, 200_000],
  [200_000, 200_000, 200_000],
  [200_000, 200_000, 200_000],
  [200_000, 200_000, 200_000],
  [200_000, 200_000, 200_000],
  [200_000, 200_000, 200_000],
];

async function wipeSchemeFinancials(scheme) {
  const { tenantId, _id: schemeId } = scheme;
  await LedgerEntry.collection.deleteMany({ tenantId, schemeId });
  await Payment.collection.deleteMany({ tenantId, schemeId });
  await PaymentIntent.collection.deleteMany({ tenantId, schemeId });
  await PaymentLink.collection.deleteMany({ tenantId, schemeId });
}

async function resetSchemeShell(scheme, cycles) {
  const maturityDate = cycles.at(-1).expiresAt.slice(0, 10);
  scheme.startDate = SCHEME_START;
  scheme.maturityDate = maturityDate;
  scheme.cycles = cycles;
  scheme.status = SchemeStatus.ACTIVE;
  scheme.flexiblePhase = FlexiblePhase.FLEXIBLE;
  scheme.positionVersion = 0;
  scheme.lockedAveragePaise = 0;
  scheme.lockedAt = undefined;
  scheme.flexibleLockAudit = undefined;
  scheme.version = (scheme.version ?? 0) + 1;
  await scheme.save();
}

async function main() {
  await connectDatabase();

  const tenant = await Tenant.findById(TENANT_ID);
  const owner = await User.findById(OWNER_USER_ID);
  const scheme = await Scheme.findOne({ _id: SCHEME_ID, tenantId: TENANT_ID });
  if (!tenant || !owner || !scheme) {
    throw new Error("Missing tenant, owner, or Sarath scheme — check IDs.");
  }

  const ctx = makeOwnerCtx(tenant, owner);
  const cycles = buildFreshCycles(scheme.planSnapshot, SCHEME_START);
  const freeCycleKeys = cycles.slice(0, 6).map((row) => row.cycle);

  console.log(`Resetting ${scheme.enrollmentNumber} · start ${SCHEME_START}`);
  console.log(`Free cycles: ${freeCycleKeys.join(", ")} · first capped: ${cycles[6]?.cycle}`);

  await wipeSchemeFinancials(scheme);
  await resetSchemeShell(scheme, cycles);

  for (let i = 0; i < freeCycleKeys.length; i += 1) {
    const cycleKey = freeCycleKeys[i];
    const amounts = FREE_MONTH_PAYMENTS[i] ?? [50_000, 50_000];
    for (const amountPaise of amounts) {
      await recordFlexPayment(ctx, scheme._id, amountPaise, cycleKey);
    }
    console.log(`  free ${cycleKey}: ${amounts.length} payments`);
  }

  await applyFlexibleLock(
    { ...ctx, params: { schemeId: scheme._id } },
    { referenceDate: today() },
  );

  let locked = await Scheme.findById(scheme._id);
  const cappedCycle = monthKey();
  const capPaise = locked.cycles.find((row) => row.cycle === cappedCycle)?.capPaise ?? 0;
  console.log(
    `Locked · status ${locked.status} · phase ${locked.flexiblePhase} · monthly cap ${capPaise} paise (₹${capPaise / 100})`,
  );

  await recordFlexPayment(ctx, scheme._id, 100_000, cappedCycle, "CASH");

  locked = await Scheme.findById(scheme._id);
  const cappedRow = locked.cycles.find((row) => row.cycle === cappedCycle);
  console.log(
    `Capped ${cappedCycle}: paid ${cappedRow?.paidPaise} / cap ${cappedRow?.capPaise} · remaining ${cappedRow?.remainingPaise}`,
  );
  console.log(`positionVersion ${locked.positionVersion} · done.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
