/** Default unpaid checkout window (minutes). */
export const PENDING_PAYMENT_WINDOW_DEFAULT_MINUTES = 30;
export const PENDING_PAYMENT_WINDOW_MIN_MINUTES = 5;
export const PENDING_PAYMENT_WINDOW_MAX_MINUTES = 120;

export function clampPendingPaymentWindowMinutes(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return PENDING_PAYMENT_WINDOW_DEFAULT_MINUTES;
  const rounded = Math.round(n);
  return Math.min(
    PENDING_PAYMENT_WINDOW_MAX_MINUTES,
    Math.max(PENDING_PAYMENT_WINDOW_MIN_MINUTES, rounded),
  );
}

export function resolvePendingPaymentWindowMinutes(fulfilmentSettingsRow) {
  return clampPendingPaymentWindowMinutes(
    fulfilmentSettingsRow?.pendingPaymentWindowMinutes,
  );
}

export function computePendingPaymentExpiresAt(fromDate, fulfilmentSettingsRow) {
  const minutes = resolvePendingPaymentWindowMinutes(fulfilmentSettingsRow);
  return new Date(fromDate.getTime() + minutes * 60_000);
}

/** Jeweller must approve scheme checkout before customer online payment (if any). */
export const SCHEME_PURCHASE_APPROVAL_WINDOW_DEFAULT_HOURS = 24;

export function computeSchemePurchaseApprovalExpiresAt(fromDate, fulfilmentSettingsRow) {
  const hours = Number(fulfilmentSettingsRow?.schemePurchaseApprovalWindowHours);
  const safe = Number.isFinite(hours) && hours > 0
    ? Math.min(24 * 30, Math.max(1, Math.round(hours)))
    : SCHEME_PURCHASE_APPROVAL_WINDOW_DEFAULT_HOURS;
  return new Date(fromDate.getTime() + safe * 60 * 60_000);
}
