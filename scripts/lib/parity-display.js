/** Match UI number formatting (en-IN) for Playwright body assertions. */
export function moneyRupees(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number(value));
}

export function countDisplay(value) {
  return new Intl.NumberFormat("en-IN").format(Number(value));
}

export function bodyIncludesMoneyRef(body, ref) {
  if (!ref || typeof ref !== "object") return false;
  const normalized = body.replace(/\u00a0/g, " ");
  const display = ref.amountDisplay;
  if (typeof display === "string" && display.trim()) {
    if (normalized.includes(display.replace(/\u00a0/g, " "))) return true;
  }
  if (typeof ref.amountPaise === "number") {
    return bodyIncludesValue(body, ref.amountPaise, { kind: "paise" });
  }
  return false;
}

export function bodyIncludesValue(body, value, { kind = "count" } = {}) {
  if (value == null || Number.isNaN(Number(value))) return false;
  const n = Number(value);
  const variants = new Set([
    String(n),
    String(Math.round(n)),
    countDisplay(n),
    countDisplay(Math.round(n)),
  ]);
  if (kind === "currency" || kind === "rupees") {
    variants.add(moneyRupees(n));
    variants.add(moneyRupees(Math.round(n)));
  }
  if (kind === "paise") {
    variants.add(moneyRupees(n / 100));
    variants.add(moneyRupees(Math.round(n / 100)));
  }
  const normalized = body.replace(/\u00a0/g, " ");
  for (const token of variants) {
    if (token && normalized.includes(token)) return true;
  }
  return false;
}

export const REPORT_KEYS = [
  "COLLECTION",
  "ENROLMENT",
  "OUTSTANDING",
  "MATURITY_REDEMPTION",
  "GOLD_ACCRUAL",
  "CUSTOMER_PERFORMANCE",
  "STAFF_PERFORMANCE",
  "CASH_HANDOVER",
  "REMINDER_DELIVERY",
  "WHATSAPP_USAGE",
  "SCHEME_REGISTER",
  "DEFAULTER",
  "BRANCH_PERFORMANCE",
  "SCHEME_PERFORMANCE",
];

export const TENANT_ROUTES = [
  ["/dashboard", "dashboard"],
  ["/customers", "customers"],
  ["/enrollments", "enrollments"],
  ["/dues", "dues"],
  ["/collections", "collections"],
  ["/cash-control", "cash-control"],
  ["/maturity", "maturity"],
  ["/gold-rates", "gold-rates"],
  ["/reminders", "reminders"],
  ["/support", "support"],
  ["/schemes", "schemes"],
  ["/staff-branches", "staff-branches"],
  ["/audit", "audit"],
  ["/alerts", "alerts"],
  ["/settings", "settings"],
  ["/settings/profile", "settings-profile"],
  ["/settings/branding", "settings-branding"],
  ["/settings/operations", "settings-operations"],
  ["/settings/subscription", "settings-subscription"],
];
