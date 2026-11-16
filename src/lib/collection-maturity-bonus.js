import { collectionBonusWeight, maturityGoldRules } from "./maturity-gold-benefit.js";
import { assessMaturityContributionEligibility } from "./maturity-eligibility.js";
import { LedgerEntryType } from "../constants/enums.js";
import { LedgerEntry } from "../models/index.js";
import { nextSchemeLedgerSequence } from "../services/sequence.service.js";
import { computeNetAllocatedLedgerTotals, loadExcludedPaymentIdsForLedgerEntries } from "./flexible-lock-settlement.js";
import { latestGoldRate22KOnOrBefore } from "./gold-rate-lookup.js";
import { createId } from "./ids.js";
export { collectionBonusWeight } from "./maturity-gold-benefit.js";

export function postedCollectionBonusWeight(entries) {
  return Math.max(0, entries.reduce((weight, entry) =>
    entry.type === LedgerEntryType.MATURITY_GOLD_CREDIT || entry.type === LedgerEntryType.MATURITY_GOLD_ADJUSTMENT
      ? weight + Number(entry.weightMg ?? 0)
      : weight, 0));
}

export async function createBonusEntry(scheme, { weightMg, ratePerGramPaise, eventKey, previousEntryId, session }) {
  const sequence = await nextSchemeLedgerSequence(scheme.tenantId, scheme._id, session);
  const [entry] = await LedgerEntry.create([{
    _id: createId("ledger"),
    tenantId: scheme.tenantId,
    branchId: scheme.branchId,
    customerId: scheme.customerId,
    schemeId: scheme._id,
    sequence,
    type: previousEntryId ? LedgerEntryType.MATURITY_GOLD_ADJUSTMENT : LedgerEntryType.MATURITY_GOLD_CREDIT,
    amountPaise: 0,
    weightMg,
    ratePerGramPaise,
    actorType: "SYSTEM",
    maturityEventKey: eventKey,
    reversalOf: previousEntryId,
    description: previousEntryId ? "Maturity gold adjusted after payment reversal" : "Maturity gold credited",
  }], { session });
  return entry;
}

export async function netPrincipal(scheme, entries, session) {
  const excluded = await loadExcludedPaymentIdsForLedgerEntries(entries, scheme.tenantId, session);
  return computeNetAllocatedLedgerTotals(entries.filter((row) => row.type !== LedgerEntryType.BENEFIT_CREDIT), excluded);
}

export async function calculateCollectionMaturityBonus(scheme, session) {
  const rules = maturityGoldRules(scheme.planSnapshot);
  const entries = await LedgerEntry.find({ tenantId: scheme.tenantId, schemeId: scheme._id }).session(session).lean();
  const totals = await netPrincipal(scheme, entries, session);
  if (!totals.goldWeightMg || !totals.amountPaidPaise) return { status: "INELIGIBLE", weightMg: 0 };
  let ratePerGramPaise;
  if (rules.bonusBasis === "NET_PAID_AT_MATURITY_RATE") {
    const rate = await latestGoldRate22KOnOrBefore(scheme, scheme.maturityDate, session);
    if (!rate?.ratePerGramPaise) return { status: "PENDING_RATE", weightMg: 0 };
    ratePerGramPaise = rate.ratePerGramPaise;
  }
  const weightMg = collectionBonusWeight(rules, totals, scheme.planSnapshot.goldRules, ratePerGramPaise);
  if (!weightMg) return { status: "INELIGIBLE", weightMg: 0, ratePerGramPaise };
  return { status: "CREDITED", weightMg, ratePerGramPaise };
}

export async function postCollectionMaturityBonus(scheme, bonus, session) {
  const entry = await createBonusEntry(scheme, { ...bonus, eventKey: "MATURITY", session });
  return { ...bonus, postedAt: entry.effectiveAt, ledgerEntryId: entry._id };
}

export async function adjustCollectionBonusAfterRefund(scheme, entries, refundKey, session) {
  const prior = scheme.collectionBonus;
  if (!prior?.ledgerEntryId) return;
  const rules = maturityGoldRules(scheme.planSnapshot);
  const totals = await netPrincipal(scheme, entries, session);
  const eligible = assessMaturityContributionEligibility(scheme).paymentEligible;
  const weightMg = eligible && totals.goldWeightMg > 0 && totals.amountPaidPaise > 0
    ? collectionBonusWeight(rules, totals, scheme.planSnapshot.goldRules, prior.ratePerGramPaise)
    : 0;
  const changeMg = weightMg - postedCollectionBonusWeight(entries);
  if (!changeMg) return;
  await createBonusEntry(scheme, {
    weightMg: changeMg, ratePerGramPaise: prior.ratePerGramPaise, eventKey: refundKey,
    previousEntryId: prior.ledgerEntryId, session,
  });
  scheme.collectionBonus.weightMg = weightMg;
  scheme.collectionBonus.status = weightMg > 0 ? "CREDITED" : "INELIGIBLE";
}
