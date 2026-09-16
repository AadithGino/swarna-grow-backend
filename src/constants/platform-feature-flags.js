/** Canonical platform feature flags (kill switches). */
export const PLATFORM_FEATURE_FLAG_KEYS = Object.freeze([
  "customerSelfEnrol",
  "flexibleScheme",
  "passbookImageOnPayment",
  "onlinePayments",
  "staffAppEnabled",
  "customerAppEnabled",
]);

export const DEFAULT_PLATFORM_FEATURE_FLAGS = Object.freeze(
  Object.fromEntries(PLATFORM_FEATURE_FLAG_KEYS.map((key) => [key, true])),
);

export function normalizeFeatureFlags(input) {
  const flags = { ...DEFAULT_PLATFORM_FEATURE_FLAGS };
  if (!input) return flags;
  if (input instanceof Map) {
    for (const key of PLATFORM_FEATURE_FLAG_KEYS) if (input.has(key)) flags[key] = Boolean(input.get(key));
    return flags;
  }
  if (typeof input === "object") {
    for (const key of PLATFORM_FEATURE_FLAG_KEYS) if (input[key] !== undefined) flags[key] = Boolean(input[key]);
  }
  return flags;
}
