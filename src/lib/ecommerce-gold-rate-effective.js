export function resolveEcommerceGoldRateEffectiveAt(body) {
  const timing = body.effectiveTiming ?? (body.effectiveAt ? "SCHEDULED" : "NOW");
  if (timing === "NOW") {
    return { effectiveAt: new Date(), effectiveTiming: "NOW" };
  }
  return { effectiveAt: new Date(body.effectiveAt), effectiveTiming: "SCHEDULED" };
}
