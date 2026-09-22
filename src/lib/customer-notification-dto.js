import { moneyRef } from "./money.js";

function planLabel(scheme) {
  if (!scheme) return "your scheme";
  return (
    scheme.planSnapshot?.displayName ??
    scheme.planSnapshot?.name ??
    scheme.enrollmentNumber ??
    "your scheme"
  );
}

function uiTypeForMessageType(type) {
  switch (type) {
    case "PAYMENT_SUCCESS":
    case "PAYMENT_DUE":
    case "PAYMENT_OVERDUE":
      return "PAYMENT";
    case "SCHEME_JOINED":
    case "SCHEME_MATURED":
    case "SCHEME_CLOSED":
    case "FLEXI_LOCK_APPLIED":
      return "SCHEME";
    case "GRIEVANCE":
      return "GRIEVANCE";
    default:
      return "GENERAL";
  }
}

function isInternalTemplateKey(value) {
  if (!value || typeof value !== "string") return false;
  return (
    value.includes("_FALLBACK") ||
    value.includes("_MEDIA") ||
    value.endsWith("_TEXT") ||
    /^[A-Z0-9_]+$/.test(value)
  );
}

function titleForRow(row) {
  if (row.title && !isInternalTemplateKey(row.title)) return row.title;
  switch (row.type) {
    case "PAYMENT_SUCCESS":
      return "Payment received";
    case "PAYMENT_DUE":
      return "Instalment due";
    case "PAYMENT_OVERDUE":
      return "Payment overdue";
    case "SCHEME_JOINED":
      return "Scheme enrolled";
    case "SCHEME_MATURED":
      return "Scheme matured";
    case "SCHEME_CLOSED":
      return "Scheme closed";
    case "FLEXI_LOCK_APPLIED":
      return "Monthly cap locked";
    case "OTP":
      return "Verification code";
    default:
      if (row.templateKey?.includes("PAYMENT_SUCCESS")) return "Payment received";
      return "Update from your jeweller";
  }
}

function bodyForRow(row, ctx) {
  if (row.body && !isInternalTemplateKey(row.body)) return row.body;
  if (row.preview && !isInternalTemplateKey(row.preview)) return row.preview;

  const paymentId = row.templateParams?.paymentId;
  const payment = paymentId ? ctx.paymentById?.get(String(paymentId)) : null;
  const scheme =
    (row.schemeId ? ctx.schemeById?.get(String(row.schemeId)) : null) ??
    (payment?.schemeId ? ctx.schemeById?.get(String(payment.schemeId)) : null);
  const label = planLabel(scheme);
  const enr = scheme?.enrollmentNumber;

  switch (row.type) {
    case "PAYMENT_SUCCESS": {
      const amount = payment ? moneyRef(payment.amountPaise).amountDisplay : null;
      const receipt = payment?.receiptNumber;
      if (amount) {
        let text = `${amount} was credited to ${label}.`;
        if (enr) text = `${amount} was credited to ${label} (${enr}).`;
        if (receipt) text += ` Receipt ${receipt}.`;
        return text;
      }
      return `Your payment to ${label} was successful.`;
    }
    case "PAYMENT_DUE":
      return enr
        ? `Your next instalment for ${label} (${enr}) is due. Pay securely from the app.`
        : `Your next instalment for ${label} is due. Pay securely from the app.`;
    case "PAYMENT_OVERDUE":
      return enr
        ? `An instalment for ${label} (${enr}) is overdue. Please pay at your earliest convenience.`
        : `An instalment for ${label} is overdue. Please pay at your earliest convenience.`;
    case "SCHEME_JOINED":
      return enr
        ? `You are enrolled in ${label}. Your scheme number is ${enr}.`
        : `You are enrolled in ${label}.`;
    case "SCHEME_MATURED":
      return `${label} has reached maturity. View your scheme for redemption options.`;
    case "SCHEME_CLOSED":
      return `${label} is now closed. Your passbook and receipts remain available in the app.`;
    case "FLEXI_LOCK_APPLIED":
      return `Your flexible phase has ended and your monthly cap for ${label} is now locked.`;
    default:
      return "Tap to view details in the app.";
  }
}

function deepLinkForRow(row, ctx) {
  if (row.deepLink ?? row.actionPath) return row.deepLink ?? row.actionPath;
  const paymentId = row.templateParams?.paymentId;
  const payment = paymentId ? ctx.paymentById?.get(String(paymentId)) : null;
  if (payment?._id) return `/payments/${payment._id}`;
  if (row.schemeId) return `/schemes/${row.schemeId}`;
  return null;
}

function ctaForRow(row, ctx) {
  if (row.ctaLabel) return row.ctaLabel;
  const paymentId = row.templateParams?.paymentId;
  if (paymentId && ctx.paymentById?.has(String(paymentId))) return "View receipt";
  if (row.type === "PAYMENT_DUE" || row.type === "PAYMENT_OVERDUE") return "Pay now";
  if (row.schemeId) return "View scheme";
  return null;
}

/** Maps a WhatsApp / messaging row to customer in-app notification copy. */
export function mapCustomerNotification(row, ctx = {}) {
  return {
    id: row._id,
    type: uiTypeForMessageType(row.type),
    title: titleForRow(row),
    body: bodyForRow(row, ctx),
    createdAt: row.createdAt,
    read: Boolean(row.readAt),
    deepLink: deepLinkForRow(row, ctx),
    cta: ctaForRow(row, ctx),
    imageUrl: row.imageUrl ?? null,
  };
}

export function buildNotificationContext({ payments = [], schemes = [] } = {}) {
  return {
    paymentById: new Map(payments.map((p) => [String(p._id), p])),
    schemeById: new Map(schemes.map((s) => [String(s._id), s])),
  };
}

/** One in-app row per business event (WhatsApp + push enqueue separate Message docs). */
export function customerNotificationDedupeKey(row) {
  if (row.reminderDedupeKey) return String(row.reminderDedupeKey);
  const params = row.templateParams ?? {};
  if (params.inboxEventKey) return String(params.inboxEventKey);
  if (params.outboxEventId) return `${row.type}|${params.outboxEventId}`;
  const cyclePart =
    params.cycleKey ??
    params.targetCycle ??
    (params.installmentNumber != null ? `inst:${params.installmentNumber}` : "");
  const occurrence =
    params.reminderDate ??
    params.occurrenceKey ??
    params.offsetKey ??
    "";
  const paymentPart = params.paymentId ?? "";
  const redemptionPart = params.redemptionId ?? "";
  const refundPart = params.refundId ?? params.paymentRefundId ?? "";
  return [
    row.type,
    String(row.schemeId ?? ""),
    String(cyclePart),
    String(paymentPart),
    String(redemptionPart),
    String(refundPart),
    String(occurrence),
  ].join("|");
}

function preferCustomerNotificationRow(a, b) {
  const channelRank = (row) => {
    if (row.channel === "PUSH") return 2;
    if (row.channel === "WHATSAPP") return 1;
    return 0;
  };
  const rankDiff = channelRank(a) - channelRank(b);
  if (rankDiff !== 0) return rankDiff > 0 ? a : b;
  if (Boolean(a.readAt) !== Boolean(b.readAt)) return a.readAt ? a : b;
  return new Date(a.createdAt) >= new Date(b.createdAt) ? a : b;
}

export function dedupeCustomerNotificationRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = customerNotificationDedupeKey(row);
    const existing = byKey.get(key);
    byKey.set(key, existing ? preferCustomerNotificationRow(existing, row) : row);
  }
  return [...byKey.values()].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export function countUnreadDedupedNotifications(rows) {
  return dedupeCustomerNotificationRows(rows).filter((row) => !row.readAt).length;
}
