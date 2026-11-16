import { queueCustomerNotification } from "./customer-notification.service.js";
import { LedgerEntry } from "../models/index.js";
import { createBonusEntry, netPrincipal, postedCollectionBonusWeight } from "../lib/collection-maturity-bonus.js";
import { goldRateForExactDate } from "../lib/gold-rate-lookup.js";
import { oneTimeCreditWeight } from "../lib/one-time-gold-schedule.js";

export async function updateOneTimeGoldPeriods(scheme, { today, session, entries, adjustmentKey, forfeit = false }) {
  const state = scheme.oneTimeGold;
  if (!state) return;
  const rules = scheme.planSnapshot.oneTimeRules;
  const ledger = entries ?? await LedgerEntry.find({ tenantId: scheme.tenantId, schemeId: scheme._id }).session(session).lean();
  const principal = await netPrincipal(scheme, ledger, session);
  const periods = state.periods.map((period) => ({ ...period }));
  const funded = principal.amountPaidPaise > 0 && principal.goldWeightMg > 0;
  const refund = adjustmentKey != null;
  for (const row of periods) {
    if (forfeit || !funded) {
      row.status = forfeit ? "FORFEITED" : "CANCELLED";
      row.weightMg = 0;
      continue;
    }
    if (refund) {
      if (row.status !== "CREDITED") continue;
    } else if (row.dueDate > today || !["PENDING", "PENDING_RATE"].includes(row.status)) {
      continue;
    }
    const rate = rules.basis === "RUPEE_PAISE"
      ? row.ratePerGramPaise ?? (await goldRateForExactDate(scheme, row.dueDate, session))?.ratePerGramPaise
      : undefined;
    if (rules.basis === "RUPEE_PAISE" && !rate) {
      row.status = "PENDING_RATE";
      continue;
    }
    const weightMg = oneTimeCreditWeight({
      rules, period: row.period, count: periods.length, principal, originalPaidPaise: state.originalPaidPaise,
      rate, goldRules: scheme.planSnapshot.goldRules,
    });
    if (!refund && weightMg > 0) {
      const entry = await createBonusEntry(scheme, { weightMg, ratePerGramPaise: rate, eventKey: `ONE_TIME:${row.period}`, session });
      row.ledgerEntryId = entry._id;
      await queueCustomerNotification({
        tenantId: scheme.tenantId, branchId: scheme.branchId, customerId: scheme.customerId, schemeId: scheme._id,
        type: "SCHEME_GOLD_BONUS_CREDITED", pushOnly: true, templateParams: { period: row.period, weightMg },
      }, { session });
    }
    Object.assign(row, { weightMg, ratePerGramPaise: rate, status: "CREDITED" });
  }
  if (refund) {
    const delta = periods.reduce((sum, row) => sum + row.weightMg, 0) - postedCollectionBonusWeight(ledger);
    if (delta) {
      const prior = state.periods.find((row) => row.ledgerEntryId);
      await createBonusEntry(scheme, { weightMg: delta, eventKey: adjustmentKey, previousEntryId: prior.ledgerEntryId, session });
    }
  }
  if (refund && !forfeit && !funded) {
    scheme.status = "CLOSED_PREMATURE";
    scheme.closureReason = "ONE_TIME_FUNDING_REVERSED";
    scheme.closedAt = new Date();
  }
  const pending = periods.find((row) => ["PENDING", "PENDING_RATE"].includes(row.status));
  const nextState = { ...state, periods, nextCreditDate: pending?.dueDate };
  if (JSON.stringify(state) !== JSON.stringify(nextState)) {
    scheme.oneTimeGold = nextState;
  }
  return { resolved: !pending, funded };
}
