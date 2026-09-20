import { PaymentPattern, ValueBasis } from "../constants/enums.js";
import { planBody } from "../validators/common.validators.js";
import { errors } from "../lib/app-error.js";

/** Fields covered by {@link planBody} (complete plan configuration). */
const PLAN_CONFIG_KEYS = [
  "name",
  "code",
  "displayName",
  "description",
  "termsText",
  "valueBasis",
  "paymentPattern",
  "durationMonths",
  "installmentCount",
  "amountRules",
  "scheduleRules",
  "paymentRules",
  "flexibleRules",
  "goldRules",
  "benefit",
  "redemptionRules",
  "availability",
  "status",
];

function mergeNestedObject(current, patch) {
  if (patch === null) return null;
  if (patch === undefined) return current;
  if (typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (
      value !== undefined
      && typeof value === "object"
      && value !== null
      && !Array.isArray(value)
      && typeof base[key] === "object"
      && base[key] !== null
      && !Array.isArray(base[key])
    ) {
      merged[key] = mergeNestedObject(base[key], value);
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

export function pickPlanConfig(doc) {
  const out = {};
  for (const key of PLAN_CONFIG_KEYS) {
    if (doc?.[key] !== undefined) out[key] = doc[key];
  }
  return out;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isMeaningfulFlexibleRules(rules) {
  if (!rules || typeof rules !== "object") return false;
  return (rules.flexiblePhaseCycles ?? 0) > 0 || (rules.cappedPhaseCycles ?? 0) > 0;
}

function isMeaningfulGoldRules(rules) {
  if (!rules || typeof rules !== "object") return false;
  return Boolean(rules.rateSource);
}

/** Strip Mongoose integer defaults (0) and empty subdocs before Zod complete-plan parse. */
export function preparePlanForCompleteValidation(planLike) {
  const config = pickPlanConfig(cloneJson(planLike));
  if (config.paymentPattern !== PaymentPattern.FLEXIBLE) {
    if (!isMeaningfulFlexibleRules(config.flexibleRules)) {
      config.flexibleRules = null;
    }
  } else if (config.flexibleRules?.flexiblePhase?.maxPaymentsPerCycle === 0) {
    config.flexibleRules.flexiblePhase.maxPaymentsPerCycle = null;
  }
  if (config.valueBasis !== ValueBasis.GOLD_WEIGHT) {
    if (!isMeaningfulGoldRules(config.goldRules)) {
      config.goldRules = null;
    }
  }
  return config;
}

/** Merge a validated PATCH body onto a persisted plan document (plain object). */
export function mergePlanPatch(current, patch) {
  const merged = { ...current, ...patch };
  const nestedKeys = [
    "amountRules",
    "scheduleRules",
    "paymentRules",
    "flexibleRules",
    "goldRules",
    "benefit",
    "redemptionRules",
    "availability",
  ];
  for (const key of nestedKeys) {
    if (patch[key] === undefined) continue;
    merged[key] = mergeNestedObject(current[key], patch[key]);
  }
  if (patch.benefit !== undefined && patch.benefit?.eligibility) {
    merged.benefit = {
      ...merged.benefit,
      eligibility: mergeNestedObject(
        current.benefit?.eligibility,
        patch.benefit.eligibility,
      ),
    };
  }
  return merged;
}

function zodIssuesToDetails(issues) {
  return issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
}

/** Authoritative complete-plan validation (same schema as POST /scheme-plans). */
export function validateCompletePlan(planLike) {
  const parsed = planBody.safeParse(preparePlanForCompleteValidation(planLike));
  if (!parsed.success) {
    throw errors.validation(zodIssuesToDetails(parsed.error.issues));
  }
  return parsed.data;
}
