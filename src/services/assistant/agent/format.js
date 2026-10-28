/**
 * Display helpers for Sidekick agent results.
 *
 * Two audiences:
 *  - the UI gets typed cells (currency/weight/datetime) it can render and export;
 *  - the model gets short display strings (₹, grams, IST dates) with personal
 *    contact details masked, so it can phrase answers without doing unit math.
 */

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});
const INR_PRECISE = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const COUNT = new Intl.NumberFormat("en-IN");

export function rupeesDisplay(paise) {
  const n = Number(paise);
  if (!Number.isFinite(n)) return "—";
  const rupees = n / 100;
  if (Math.abs(rupees) < 100 && !Number.isInteger(rupees)) return INR_PRECISE.format(rupees);
  return INR.format(Math.round(rupees));
}

export function countDisplay(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (Number.isInteger(v)) return COUNT.format(v);
  return COUNT.format(Math.round(v * 100) / 100);
}

/** Gold weight stored in milligrams → "12.345 g". */
export function gramsFromMgDisplay(mg) {
  const n = Number(mg);
  if (!Number.isFinite(n)) return "—";
  return `${(n / 1000).toFixed(3)} g`;
}

/** Digital metal weight stored in micrograms → "1.2345 g". */
export function gramsFromUgDisplay(ug) {
  const n = Number(ug);
  if (!Number.isFinite(n)) return "—";
  return `${(n / 1_000_000).toFixed(4)} g`;
}

export function istDateTimeDisplay(value) {
  if (value == null || value === "") return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function istDateDisplay(value) {
  if (value == null || value === "") return "—";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T12:00:00+05:30`);
    return d.toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "+919876543210" → "+91 98•••••210" — enough to tell customers apart, not to call them. */
export function maskMobile(mobile) {
  const s = String(mobile ?? "").trim();
  if (!s) return "";
  const digits = s.replace(/\D/g, "");
  if (digits.length < 6) return "•••";
  const last = digits.slice(-3);
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  return `${local.slice(0, 2)}•••••${last}`;
}

export function humanizeEnum(value) {
  if (value == null) return "—";
  const s = String(value);
  if (!/^[A-Z0-9_]+$/.test(s)) return s;
  const map = {
    UPI: "UPI",
    ONLINE_GATEWAY: "Online (gateway)",
    BANK_TRANSFER: "Bank transfer",
    LEGACY_ONLINE: "Legacy online",
    COD: "Cash on delivery",
    KYC: "KYC",
    GOLD_WEIGHT: "Gold weight",
    GOLD_HANDOVER: "Gold handover",
  };
  if (map[s]) return map[s];
  return s
    .toLowerCase()
    .split("_")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Typed value → { ui, model } pair.
 * ui: what the table/chart renders (keeps raw numbers for currency so export and charts stay exact)
 * model: compact display string for the LLM.
 */
export function presentValue(type, value, { maskPersonal = true, isMobile = false } = {}) {
  if (value === undefined || value === null || value === "") {
    return { ui: null, model: null };
  }
  switch (type) {
    case "money": {
      const n = Number(value);
      const display = rupeesDisplay(n);
      return { ui: { cell: "currency", value: n, display }, model: display };
    }
    case "weight_mg": {
      const display = gramsFromMgDisplay(value);
      return { ui: { cell: "weight", value: Number(value), display }, model: display };
    }
    case "weight_ug": {
      const display = gramsFromUgDisplay(value);
      return {
        ui: { cell: "weight", value: Number(value) / 1000, display },
        model: display,
      };
    }
    case "datetime": {
      const d = value instanceof Date ? value : new Date(value);
      const iso = Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
      return {
        ui: { cell: "datetime", value: iso, display: istDateTimeDisplay(d) },
        model: istDateTimeDisplay(d),
      };
    }
    case "ymd":
      return {
        ui: { cell: "date", value: String(value), display: istDateDisplay(value) },
        model: istDateDisplay(value),
      };
    case "enum":
      return { ui: humanizeEnum(value), model: String(value) };
    case "number":
    case "count": {
      const n = Number(value);
      return { ui: n, model: Number.isFinite(n) ? countDisplay(n) : String(value) };
    }
    case "boolean":
      return { ui: Boolean(value), model: value ? "yes" : "no" };
    case "string":
    default: {
      const s = typeof value === "object" ? JSON.stringify(value) : String(value);
      if (isMobile) return { ui: s, model: maskPersonal ? maskMobile(s) : s };
      return { ui: s, model: s.length > 120 ? `${s.slice(0, 117)}…` : s };
    }
  }
}

/** Column type hint for the UI table. */
export function columnTypeFor(type) {
  if (type === "money") return "currency";
  if (type === "weight_mg" || type === "weight_ug") return "weight";
  if (type === "datetime") return "datetime";
  if (type === "ymd") return "date";
  if (type === "number" || type === "count") return "count";
  return "text";
}

/** Stat card valueType for a typed metric. */
export function statValueType(type) {
  if (type === "money") return "currency";
  if (type === "weight_mg" || type === "weight_ug") return "weight";
  if (type === "percent") return "percent";
  if (type === "count") return "count";
  return "number";
}

/** Normalize a typed numeric value to the unit the UI expects (paise, milligrams). */
export function uiNumeric(type, value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  if (type === "weight_ug") return n / 1000;
  return n;
}
