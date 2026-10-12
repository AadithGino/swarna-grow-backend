/** Staff must accept COD orders within this window; stock stays reserved until accept, reject, or expiry. */
export const COD_ACCEPTANCE_WINDOW_DEFAULT_MINUTES = 120;
export const COD_ACCEPTANCE_WINDOW_MIN_MINUTES = 30;
export const COD_ACCEPTANCE_WINDOW_MAX_MINUTES = 2880;

export function clampCodAcceptanceWindowMinutes(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return COD_ACCEPTANCE_WINDOW_DEFAULT_MINUTES;
  return Math.min(
    COD_ACCEPTANCE_WINDOW_MAX_MINUTES,
    Math.max(COD_ACCEPTANCE_WINDOW_MIN_MINUTES, Math.floor(n)),
  );
}

export function resolveCodAcceptanceWindowMinutes(fulfilmentSettingsRow) {
  return clampCodAcceptanceWindowMinutes(
    fulfilmentSettingsRow?.codAcceptanceWindowMinutes,
  );
}

export function computeCodAcceptanceExpiresAt(fromDate, fulfilmentSettingsRow) {
  const minutes = resolveCodAcceptanceWindowMinutes(fulfilmentSettingsRow);
  return new Date(fromDate.getTime() + minutes * 60_000);
}
