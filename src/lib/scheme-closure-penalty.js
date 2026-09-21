/** Authoritative premature-closure penalty (integer paise). PRORATE is not supported. */
export function computeClosurePenaltyPaise(
  penaltyRule,
  netPaidPrincipalPaise,
  { isPremature, systemPolicyClosure },
) {
  if (systemPolicyClosure || !isPremature) return 0;
  if (!penaltyRule || penaltyRule.mode === "NONE") return 0;
  const paid = Math.max(0, Number(netPaidPrincipalPaise ?? 0));
  if (penaltyRule.mode === "PERCENT_OF_PAID") {
    return Math.floor((paid * (penaltyRule.value ?? 0)) / 100);
  }
  if (penaltyRule.mode === "FLAT") {
    return Math.max(0, penaltyRule.flatPaise ?? penaltyRule.value ?? 0);
  }
  return Math.max(0, penaltyRule.value ?? 0);
}
