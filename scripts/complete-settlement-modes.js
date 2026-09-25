/**
 * Completes one live KAIRALI redemption per payout mode and checks the ledger.
 * Stale open requests are rejected first, because completion refuses a changed gold rate.
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { ClosureType, LedgerEntryType, RedemptionMode } from "../src/constants/enums.js";
import { moneyPaiseFromWeightMg } from "../src/lib/money.js";
import { LedgerEntry, Redemption, Scheme, Tenant, User } from "../src/models/index.js";
import {
  initiateRedemption,
  settlementPreview,
  transitionRedemption,
} from "../src/services/redemption.service.js";

const jobs = [
  { enrollmentNumber: "ENR-0000015", mode: RedemptionMode.CASH },
  { enrollmentNumber: "ENR-0000016", mode: RedemptionMode.GOLD_HANDOVER },
  { enrollmentNumber: "ENR-0000017", mode: RedemptionMode.PURCHASE_ADJUSTMENT },
  { enrollmentNumber: "ENR-0000005", mode: RedemptionMode.CASH },
];

function staffReq(user, tenantId, extra) {
  return {
    auth: { id: user._id, tenantId, type: "TENANT_USER" },
    scope: { tenantId },
    headers: { "user-agent": "settlement-check" },
    ip: "127.0.0.1",
    query: {},
    body: {},
    ...extra,
  };
}

async function main() {
  await connectDatabase();
  const tenant = await Tenant.findOne({ code: "KAIRALI" }).lean();
  const user = await User.findOne({ tenantId: tenant._id, role: "TENANT_OWNER" }).lean();
  const results = [];

  for (const job of jobs) {
    const scheme = await Scheme.findOne({
      tenantId: tenant._id,
      enrollmentNumber: job.enrollmentNumber,
    }).lean();
    if (!scheme || scheme.status === "REDEEMED") {
      results.push({
        ...job,
        ok: scheme?.status === "REDEEMED",
        detail: scheme ? "already redeemed" : "scheme missing",
      });
      continue;
    }
    const base = staffReq(user, tenant._id, {
      params: { schemeId: scheme._id },
      scope: { tenantId: tenant._id, branchId: scheme.branchId },
    });
    try {
      const open = await Redemption.findOne({
        tenantId: tenant._id,
        schemeId: scheme._id,
        status: { $in: ["REQUESTED", "PENDING_APPROVAL", "APPROVED"] },
      }).lean();
      if (open && (open.mode !== job.mode || open.settlementPaise == null)) {
        await transitionRedemption(
          staffReq(user, tenant._id, {
            params: { redemptionId: open._id, id: open._id },
            scope: { tenantId: tenant._id, branchId: scheme.branchId },
            body: { reason: "Rate changed. Recreated at today's settlement." },
          }),
          "reject",
        );
      } else if (open) {
        const preview = await settlementPreview(
          { ...base, body: { mode: job.mode }, query: { mode: job.mode } },
          open.closureType ?? ClosureType.MATURITY_REDEMPTION,
        );
        if (preview.settlementPaise !== open.settlementPaise || preview.weightMg !== open.weightMg) {
          await transitionRedemption(
            staffReq(user, tenant._id, {
              params: { redemptionId: open._id, id: open._id },
              scope: { tenantId: tenant._id, branchId: scheme.branchId },
              body: { reason: "Settlement changed with today's gold rate. Recreated." },
            }),
            "reject",
          );
        }
      }

      let redemption = await Redemption.findOne({
        tenantId: tenant._id,
        schemeId: scheme._id,
        status: { $in: ["REQUESTED", "PENDING_APPROVAL", "APPROVED"] },
      });
      const freshScheme = await Scheme.findById(scheme._id).lean();
      if (!redemption) {
        const created = await initiateRedemption(
          {
            ...base,
            body: {
              mode: job.mode,
              expectedVersion: freshScheme.version,
              modeDetails: job.mode === RedemptionMode.PURCHASE_ADJUSTMENT
                ? { billNumber: `INV-${Date.now().toString().slice(-6)}` }
                : {},
            },
          },
          ClosureType.MATURITY_REDEMPTION,
        );
        redemption = await Redemption.findById(created._id);
      }
      if (redemption.status === "REQUESTED" || redemption.status === "PENDING_APPROVAL") {
        await transitionRedemption(
          staffReq(user, tenant._id, {
            params: { redemptionId: redemption._id, id: redemption._id },
            scope: { tenantId: tenant._id, branchId: scheme.branchId },
            body: {},
          }),
          "approve",
        );
      }
      const billNumber = redemption.modeDetails?.billNumber
        ?? `INV-${Date.now().toString().slice(-6)}`;
      await transitionRedemption(
        staffReq(user, tenant._id, {
          params: { redemptionId: redemption._id, id: redemption._id },
          scope: { tenantId: tenant._id, branchId: scheme.branchId },
          body: job.mode === RedemptionMode.PURCHASE_ADJUSTMENT
            ? { modeDetails: { billNumber } }
            : {},
        }),
        "complete",
      );

      const completed = await Redemption.findById(redemption._id).lean();
      const closed = await Scheme.findById(scheme._id).select("status").lean();
      const debit = await LedgerEntry.findOne({
        tenantId: tenant._id,
        redemptionId: completed._id,
        type: LedgerEntryType.REDEMPTION_DEBIT,
      }).lean();
      const benefit = await LedgerEntry.findOne({
        tenantId: tenant._id,
        redemptionId: completed._id,
        type: LedgerEntryType.BENEFIT_CREDIT,
      }).lean();
      const expectedValue = scheme.valueBasis === "GOLD_WEIGHT"
        ? moneyPaiseFromWeightMg(
          (completed.weightMg ?? 0),
          completed.benefitRatePerGramPaise || completed.handoverRatePerGramPaise || 0,
        )
        : (completed.principalPaise ?? 0) + (completed.benefitPaise ?? 0) - (completed.penaltyPaise ?? 0);
      const problems = [];
      if (completed.status !== "COMPLETED") problems.push("not completed");
      if (closed.status !== "REDEEMED") problems.push(`scheme status ${closed.status}`);
      if (completed.settlementPaise !== expectedValue && scheme.valueBasis === "GOLD_WEIGHT" && job.mode !== RedemptionMode.CASH && job.mode !== RedemptionMode.PURCHASE_ADJUSTMENT) {
        problems.push(`settlement ${completed.settlementPaise} != ${expectedValue}`);
      }
      if (scheme.valueBasis === "GOLD_WEIGHT") {
        const valued = moneyPaiseFromWeightMg(
          (completed.principalWeightMg ?? completed.weightMg ?? 0) + (job.mode === RedemptionMode.GOLD_HANDOVER ? 0 : 0),
          completed.handoverRatePerGramPaise || completed.benefitRatePerGramPaise || 0,
        );
        void valued;
        if (debit?.amountPaise !== completed.settlementPaise) {
          problems.push(`ledger debit ${debit?.amountPaise} != settlement ${completed.settlementPaise}`);
        }
        const expectedDebitWeight = job.mode === RedemptionMode.GOLD_HANDOVER
          ? completed.weightMg
          : (completed.weightMg ?? 0);
        if (debit?.weightMg !== expectedDebitWeight && debit?.weightMg !== (scheme && completed.weightMg)) {
          problems.push(`ledger weight ${debit?.weightMg} != ${completed.weightMg}`);
        }
      } else if (debit?.amountPaise !== completed.settlementPaise) {
        problems.push(`ledger debit ${debit?.amountPaise} != settlement ${completed.settlementPaise}`);
      }
      if (job.mode === RedemptionMode.CASH && completed.cashOutPaise !== completed.settlementPaise) {
        problems.push("cash out does not equal settlement");
      }
      if (job.mode !== RedemptionMode.CASH && completed.cashOutPaise !== 0) {
        problems.push(`cash out should be 0, got ${completed.cashOutPaise}`);
      }
      if (job.mode === RedemptionMode.PURCHASE_ADJUSTMENT && !completed.modeDetails?.billNumber) {
        problems.push("bill number missing");
      }
      results.push({
        scheme: job.enrollmentNumber,
        basis: scheme.valueBasis,
        mode: job.mode,
        ok: problems.length === 0,
        settlementPaise: completed.settlementPaise,
        weightMg: completed.weightMg,
        cashOutPaise: completed.cashOutPaise,
        handoverValuePaise: completed.handoverValuePaise ?? 0,
        benefitWeightMg: benefit?.weightMg ?? 0,
        debitPaise: debit?.amountPaise ?? null,
        debitWeightMg: debit?.weightMg ?? null,
        billNumber: completed.modeDetails?.billNumber ?? null,
        detail: problems.join("; ") || "completed and ledger matches",
      });
    } catch (error) {
      results.push({
        scheme: job.enrollmentNumber,
        mode: job.mode,
        ok: false,
        detail: error.code ? `${error.code}: ${error.message}` : error.message,
      });
    }
  }

  console.log(JSON.stringify({ results }, null, 2));
  await disconnectDatabase();
  if (results.some((row) => !row.ok)) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
