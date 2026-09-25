/**
 * Read-only check: live settlement preview vs ledger + today's exact rate.
 * Does not complete redemptions.
 */
import Decimal from "decimal.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { ClosureType, RedemptionMode, ValueBasis } from "../src/constants/enums.js";
import { goldRateForExactDate } from "../src/lib/gold-rate-lookup.js";
import { moneyPaiseFromWeightMg, rateRef } from "../src/lib/money.js";
import { computeNetAllocatedLedgerTotals } from "../src/lib/flexible-lock-settlement.js";
import { today } from "../src/lib/date.js";
import { LedgerEntry, Redemption, Scheme, Tenant, User } from "../src/models/index.js";
import { settlementPreview } from "../src/services/redemption.service.js";

const rupees = (paise) => new Decimal(paise ?? 0).div(100).toFixed(2);
const grams = (mg) => new Decimal(mg ?? 0).div(1000).toFixed(3);

function check(label, actual, expected) {
  const ok = Number(actual) === Number(expected);
  return { ok, label, actual, expected };
}

async function main() {
  await connectDatabase();
  const tenant = await Tenant.findOne({ code: "KAIRALI" }).lean();
  if (!tenant) throw new Error("KAIRALI tenant missing");
  const user = await User.findOne({ tenantId: tenant._id, role: "TENANT_OWNER" }).lean();
  const day = today();
  const schemes = await Scheme.find({
    tenantId: tenant._id,
    status: { $in: ["MATURED", "ACTIVE", "LOCKED"] },
  }).lean();

  const rows = [];
  for (const scheme of schemes) {
    const entries = await LedgerEntry.find({ tenantId: tenant._id, schemeId: scheme._id }).lean();
    const totals = computeNetAllocatedLedgerTotals(entries, new Set());
    if (totals.amountPaidPaise <= 0 && totals.goldWeightMg <= 0) continue;
    const modes = scheme.planSnapshot?.redemptionRules?.allowedModes ?? ["CASH"];
    const rate = scheme.valueBasis === ValueBasis.GOLD_WEIGHT
      ? await goldRateForExactDate(
        { tenantId: tenant._id, branchId: scheme.branchId },
        day,
      )
      : null;

    for (const mode of modes) {
      let preview;
      let error;
      try {
        preview = await settlementPreview(
          {
            auth: { id: user._id, tenantId: tenant._id, type: "TENANT_USER" },
            scope: { tenantId: tenant._id },
            tenant,
            params: { schemeId: scheme._id },
            query: { type: ClosureType.MATURITY_REDEMPTION, mode },
            body: { mode },
            headers: {},
            ip: "127.0.0.1",
          },
          ClosureType.MATURITY_REDEMPTION,
        );
      } catch (err) {
        error = err.code ?? err.message;
      }
      if (error) {
        rows.push({
          scheme: scheme.enrollmentNumber,
          basis: scheme.valueBasis,
          status: scheme.status,
          mode,
          ok: false,
          detail: error,
        });
        continue;
      }
      if (!preview.eligible) {
        rows.push({
          scheme: scheme.enrollmentNumber,
          basis: scheme.valueBasis,
          status: scheme.status,
          mode,
          ok: true,
          detail: `not eligible: ${preview.blockers?.[0]?.code ?? "blocked"}`,
        });
        continue;
      }

      const checks = [];
      const ratePaise = preview.valuationRatePerGramPaise ?? 0;
      if (scheme.valueBasis === ValueBasis.GOLD_WEIGHT) {
        checks.push(check("rate matches lookup", ratePaise, rate?.ratePerGramPaise ?? 0));
        const principalMg = preview.principalWeightMg ?? 0;
        checks.push(check("principal weight matches ledger", principalMg, totals.goldWeightMg));
        const benefitMg = preview.benefitWeightMg ?? 0;
        const eligibleMg = principalMg + benefitMg;
        const expectedEligibleValue = moneyPaiseFromWeightMg(eligibleMg, ratePaise);
        const penalty = preview.penaltyPaise ?? 0;
        const shownMg = preview.computation?.goldWeight?.weightMg ?? preview.weightMg ?? 0;
        if (mode === RedemptionMode.GOLD_HANDOVER) {
          const handoverMg = preview.weightMg ?? 0;
          checks.push(check(
            "handover weight is principal + benefit",
            handoverMg,
            eligibleMg - (preview.penaltyWeightMg ?? 0),
          ));
          checks.push(check(
            "handover rupees = grams × rate",
            preview.settlementPaise,
            handoverMg > 0 ? moneyPaiseFromWeightMg(handoverMg, ratePaise) : 0,
          ));
        } else {
          checks.push(check(
            "valued weight is principal + benefit",
            shownMg,
            eligibleMg,
          ));
          checks.push(check(
            "cash value = eligible grams × rate − penalty",
            preview.settlementPaise,
            Math.max(0, expectedEligibleValue - penalty),
          ));
        }
        const lineSum = (preview.computation?.lines ?? []).reduce((sum, line) => {
          const paise = line.amount?.amountPaise ?? 0;
          if (line.forfeited) return sum;
          return sum + (line.sign === "-" ? -paise : paise);
        }, 0);
        checks.push(check("settlement lines add up to the final amount", lineSum, preview.settlementPaise));
        checks.push(check(
          "final value matches settlement",
          preview.computation?.finalValue?.amountPaise,
          preview.settlementPaise,
        ));
        const note = preview.modePreviews?.[mode]?.note ?? "";
        if (ratePaise > 0 && note.includes("rate")) {
          checks.push(check(
            "note shows the same rate",
            note.includes(rateRef(ratePaise).ratePerGramDisplay),
            true,
          ));
        }
      } else {
        const expected = Math.max(
          0,
          (preview.principalPaise ?? 0) + (preview.benefitPaise ?? 0) - (preview.penaltyPaise ?? 0),
        );
        checks.push(check("principal matches ledger", preview.principalPaise, totals.amountPaidPaise));
        checks.push(check("settlement = principal + benefit − penalty", preview.settlementPaise, expected));
        checks.push(check(
          "final value matches settlement",
          preview.computation?.finalValue?.amountPaise,
          preview.settlementPaise,
        ));
      }

      const failed = checks.filter((item) => !item.ok);
      rows.push({
        scheme: scheme.enrollmentNumber,
        basis: scheme.valueBasis,
        status: scheme.status,
        mode,
        ok: failed.length === 0,
        rate: ratePaise ? `₹${rupees(ratePaise)}/g` : "—",
        principal: scheme.valueBasis === ValueBasis.GOLD_WEIGHT
          ? `${grams(preview.principalWeightMg)} g`
          : `₹${rupees(preview.principalPaise)}`,
        benefit: scheme.valueBasis === ValueBasis.GOLD_WEIGHT
          ? `${grams(preview.benefitWeightMg)} g`
          : `₹${rupees(preview.benefitPaise)}`,
        settlement: `₹${rupees(preview.settlementPaise)}`,
        weight: preview.computation?.goldWeight?.weightDisplay ?? "—",
        detail: failed.length
          ? failed.map((item) => `${item.label}: got ${item.actual}, expected ${item.expected}`).join("; ")
          : "matches",
      });
    }
  }

  const open = await Redemption.find({
    tenantId: tenant._id,
    status: { $in: ["REQUESTED", "PENDING_APPROVAL", "APPROVED", "COMPLETED"] },
  }).select("schemeId mode status settlementPaise").lean();
  const byScheme = new Map(schemes.map((scheme) => [String(scheme._id), scheme.enrollmentNumber]));

  const matured = rows.filter((row) => row.status === "MATURED");
  console.log(JSON.stringify({
    valuationDate: day,
    maturedChecked: matured.length,
    maturedFailed: matured.filter((row) => !row.ok).length,
    matured,
    redemptions: open.map((row) => ({
      scheme: byScheme.get(String(row.schemeId)),
      mode: row.mode,
      status: row.status,
      settlement: `₹${rupees(row.settlementPaise)}`,
    })),
  }, null, 2));
  await disconnectDatabase();
  if (rows.some((row) => !row.ok && !String(row.detail).startsWith("not eligible") && row.detail !== "matches")) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
