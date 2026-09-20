import { schemeInstallmentStats } from "../services/report-builders/report-envelope.js";

export function portfolioStatsFromSchemes(schemes, asOfYmd) {
  let expectedToDate = 0;
  let collectedToDate = 0;
  let futureExpected = 0;
  for (const scheme of schemes) {
    const stats = schemeInstallmentStats(scheme, asOfYmd);
    expectedToDate += stats.expectedToDate;
    collectedToDate += stats.collectedToDate;
    futureExpected += stats.futureExpected;
  }
  const outstanding = Math.max(0, expectedToDate - collectedToDate);
  const efficiency = expectedToDate
    ? Math.round((collectedToDate / expectedToDate) * 1000) / 10
    : 100;
  return {
    expectedToDate,
    collectedToDate,
    outstanding,
    futureExpected,
    efficiency,
  };
}

export function sumPaidTotalFromSchemes(schemes, asOfYmd) {
  let total = 0;
  for (const scheme of schemes) {
    total += schemeInstallmentStats(scheme, asOfYmd).paidTotal;
  }
  return total;
}

export function recoveryTotalsByBranch(schemes, asOfYmd) {
  const byBranch = new Map();
  for (const scheme of schemes) {
    const branchKey = scheme.branchId ?? "__none__";
    const paid = schemeInstallmentStats(scheme, asOfYmd).paidTotal;
    byBranch.set(branchKey, (byBranch.get(branchKey) ?? 0) + paid);
  }
  return byBranch;
}
