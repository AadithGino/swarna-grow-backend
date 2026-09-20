import { MessageType } from "../constants/enums.js";
import { REMINDER_PRODUCT_TIMEZONE } from "./reminder-timezone.js";

/** Contract-aligned default reminder + push schedule (tenant overrides in settings.reminderConfig). */
export const DEFAULT_REMINDER_OFFSETS = Object.freeze([
  { key: "D_MINUS_5", label: "5 days before due", days: -5, enabled: false, messageType: MessageType.PAYMENT_DUE, schemePattern: "FIXED" },
  { key: "D_MINUS_3", label: "3 days before due", days: -3, enabled: true, messageType: MessageType.PAYMENT_DUE, schemePattern: "FIXED" },
  { key: "D_MINUS_1", label: "1 day before due", days: -1, enabled: true, messageType: MessageType.PAYMENT_DUE, schemePattern: "FIXED" },
  { key: "D_DAY", label: "On the due date", days: 0, enabled: true, messageType: MessageType.PAYMENT_DUE, schemePattern: "FIXED" },
  { key: "D_PLUS_1", label: "1 day after due", days: 1, enabled: true, messageType: MessageType.PAYMENT_OVERDUE, schemePattern: "FIXED" },
  { key: "D_PLUS_3", label: "3 days after due", days: 3, enabled: true, messageType: MessageType.PAYMENT_OVERDUE, schemePattern: "FIXED" },
  { key: "D_PLUS_7", label: "7 days after due", days: 7, enabled: true, messageType: MessageType.PAYMENT_OVERDUE, schemePattern: "FIXED" },
  { key: "D_PLUS_14", label: "14 days after due", days: 14, enabled: false, messageType: MessageType.PAYMENT_OVERDUE, schemePattern: "FIXED" },
  { key: "FLEX_NUDGE", label: "Flexible contribution nudge", days: 0, enabled: true, messageType: MessageType.PAYMENT_DUE, schemePattern: "FLEXIBLE", pushOnly: true },
  { key: "LOCK_MINUS_7", label: "7 days before flexible lock", days: -7, enabled: true, messageType: MessageType.FLEXI_LOCK_APPLIED, schemePattern: "FLEXIBLE", pushOnly: true },
  { key: "MATURITY_MINUS_7", label: "7 days before maturity", days: -7, enabled: true, messageType: MessageType.SCHEME_MATURED, schemePattern: "ANY", pushOnly: true },
  { key: "MATURITY_MINUS_1", label: "1 day before maturity", days: -1, enabled: true, messageType: MessageType.SCHEME_MATURED, schemePattern: "ANY", pushOnly: true },
]);

export const DEFAULT_REMINDER_CONFIG = Object.freeze({
  enabled: true,
  offsets: DEFAULT_REMINDER_OFFSETS,
  maxRemindersPerInstallment: 5,
  sendWindow: { startTime: "09:00", endTime: "20:00", timezone: REMINDER_PRODUCT_TIMEZONE },
  skipDays: [],
  attachPaymentLink: true,
  paymentLinkValidityHours: 72,
  flexibleNudgeInactiveDays: 7,
  maxPushPerCustomerPerDay: 3,
  /** 0 = unlimited WhatsApp reminders per customer per calendar day. */
  maxWhatsAppPerCustomerPerDay: 0,
  push: {
    enabled: true,
    mirrorWhatsAppTransactional: true,
    dueReminders: true,
    overdueReminders: true,
    paymentSuccess: true,
    schemeJoined: true,
    flexiLockApplied: true,
    schemeMatured: true,
    schemeClosed: true,
    flexibleNudge: true,
    maturityReminders: true,
  },
  transactional: {
    schemeJoined: true,
    paymentSuccess: true,
    paymentSuccessAttachPassbook: true,
    flexiLockApplied: true,
    schemeMatured: true,
    schemeClosed: true,
  },
});

function mergeOffsets(stored = []) {
  const byKey = new Map(DEFAULT_REMINDER_OFFSETS.map((row) => [row.key, { ...row }]));
  for (const row of stored) {
    if (!row?.key || !byKey.has(row.key)) continue;
    byKey.set(row.key, { ...byKey.get(row.key), ...row });
  }
  return [...byKey.values()];
}

export function getReminderConfig(tenant) {
  const stored = tenant?.settings?.reminderConfig ?? {};
  return {
    ...DEFAULT_REMINDER_CONFIG,
    ...stored,
    offsets: mergeOffsets(stored.offsets),
    sendWindow: {
      ...DEFAULT_REMINDER_CONFIG.sendWindow,
      ...(stored.sendWindow ?? {}),
      timezone: REMINDER_PRODUCT_TIMEZONE,
    },
    push: { ...DEFAULT_REMINDER_CONFIG.push, ...(stored.push ?? {}) },
    transactional: { ...DEFAULT_REMINDER_CONFIG.transactional, ...(stored.transactional ?? {}) },
  };
}

export function reminderConfigForAdmin(tenant, quotaMeta = {}) {
  const config = getReminderConfig(tenant);
  return {
    enabled: config.enabled !== false,
    offsets: config.offsets.map(({ key, label, days, enabled, messageType }) => ({
      key,
      label,
      days,
      enabled: enabled !== false,
      messageType,
    })),
    maxRemindersPerInstallment: config.maxRemindersPerInstallment,
    sendWindow: config.sendWindow,
    skipDays: config.skipDays ?? [],
    attachPaymentLink: config.attachPaymentLink !== false,
    paymentLinkValidityHours: config.paymentLinkValidityHours ?? 72,
    flexibleNudgeInactiveDays: config.flexibleNudgeInactiveDays ?? 7,
    maxPushPerCustomerPerDay: config.maxPushPerCustomerPerDay ?? 3,
    push: config.push,
    transactional: config.transactional,
    quota: quotaMeta.quota ?? undefined,
    audit: { version: tenant?.version ?? 1 },
  };
}

export function isWithinSendWindow(sendWindow, now = new Date()) {
  const tz = REMINDER_PRODUCT_TIMEZONE;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const current = hour * 60 + minute;
  const [startH, startM] = String(sendWindow?.startTime ?? "09:00").split(":").map(Number);
  const [endH, endM] = String(sendWindow?.endTime ?? "20:00").split(":").map(Number);
  const start = startH * 60 + (startM || 0);
  const end = endH * 60 + (endM || 0);
  return current >= start && current <= end;
}

export function pushEnabledForType(config, messageType, templateParams = {}) {
  if (config.push?.enabled === false) return false;
  switch (messageType) {
    case MessageType.PAYMENT_DUE:
      if (templateParams.pushKind === "FLEX_NUDGE") {
        return config.push?.flexibleNudge !== false;
      }
      return config.push?.dueReminders !== false;
    case MessageType.PAYMENT_OVERDUE:
      return config.push?.overdueReminders !== false;
    case MessageType.PAYMENT_SUCCESS:
      return config.push?.paymentSuccess !== false;
    case MessageType.SCHEME_JOINED:
      return config.push?.schemeJoined !== false;
    case MessageType.FLEXI_LOCK_APPLIED:
      return config.push?.flexiLockApplied !== false;
    case MessageType.SCHEME_MATURED:
      return config.push?.maturityReminders !== false && config.push?.schemeMatured !== false;
    case MessageType.SCHEME_CLOSED:
      return config.push?.schemeClosed !== false;
    default:
      return config.push?.enabled !== false;
  }
}

export function whatsAppEnabledForType(config, messageType) {
  if (config.enabled === false) return false;
  if (messageType === MessageType.PAYMENT_DUE || messageType === MessageType.PAYMENT_OVERDUE) {
    return true;
  }
  const tx = config.transactional ?? {};
  switch (messageType) {
    case MessageType.PAYMENT_SUCCESS:
      return tx.paymentSuccess !== false;
    case MessageType.SCHEME_JOINED:
      return tx.schemeJoined !== false;
    case MessageType.FLEXI_LOCK_APPLIED:
      return tx.flexiLockApplied !== false;
    case MessageType.SCHEME_MATURED:
      return tx.schemeMatured !== false;
    case MessageType.SCHEME_CLOSED:
      return tx.schemeClosed !== false;
    default:
      return false;
  }
}
