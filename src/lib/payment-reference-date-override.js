import { AppError } from "./app-error.js";

/** Reject client-supplied payable calendar reference dates on payment routes. */
export function rejectClientReferenceDateFields(req) {
  for (const [sourceName, source] of [
    ["body", req.body],
    ["query", req.query],
  ]) {
    if (source?.referenceDate != null && source.referenceDate !== "") {
      throw new AppError("VALIDATION_FAILED", "Please correct the highlighted fields.", 400, [
        {
          field: `${sourceName}.referenceDate`,
          message: "Reference date override is not supported on payment requests.",
        },
      ]);
    }
  }
}

/**
 * Payable-range calendar reference for seed/smoke only — never from HTTP.
 * Does not change payment.paidAt, ledger timestamps, or gold-rate effective dates.
 */
export function resolveInternalPayableReferenceDate(override = {}) {
  if (override.referenceDate == null || override.referenceDate === "") {
    return undefined;
  }
  if (process.env.NODE_ENV === "production") {
    throw new AppError(
      "REFERENCE_DATE_OVERRIDE_FORBIDDEN",
      "Internal payable reference date override is disabled in production.",
      500,
    );
  }
  if (!override.internalReferenceDateOverride) {
    throw new AppError(
      "REFERENCE_DATE_OVERRIDE_FORBIDDEN",
      "Payable reference date override requires internal authorization.",
      500,
    );
  }
  return override.referenceDate;
}
