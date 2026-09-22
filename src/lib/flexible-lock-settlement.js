import { PaymentStatus, SchemeStatus } from "../constants/enums.js";
import { LedgerEntry, OutboxEvent, Payment } from "../models/index.js";
import { writeAudit } from "../services/audit.service.js";

function ledgerTotals(entries) {
  const credits = new Set(["INSTALLMENT_PAYMENT", "FREE_WINDOW_PAYMENT", "BENEFIT_CREDIT"]);
  const debits = new Set(["REVERSAL", "CLOSURE_PENALTY", "REDEMPTION_DEBIT"]);
  return entries.reduce(
    (totals, entry) => {
      const direction = credits.has(entry.type) ? 1 : debits.has(entry.type) ? -1 : 0;
      return {
        amountPaidPaise: totals.amountPaidPaise + direction * (entry.amountPaise ?? 0),
        goldWeightMg: totals.goldWeightMg + direction * (entry.weightMg ?? 0),
      };
    },
    { amountPaidPaise: 0, goldWeightMg: 0 },
  );
}
import { AuditEntityType } from "../constants/enums.js";

import {
  isFlexSystemPolicyClosure,
} from "./system-policy-closure.js";

export {
  FLEX_SYSTEM_CLOSURE_REASONS,
  isFlexSystemPolicyClosure,
  isSystemPolicyClosureSettlement,
  SYSTEM_POLICY_CLOSURE_REASONS,
} from "./system-policy-closure.js";

/** Net allocated principal from ledger (excludes UNALLOCATED and non-allocated payments). */
export function computeNetAllocatedPrincipalPaise(entries) {
  return computeNetAllocatedLedgerTotals(entries, new Set()).amountPaidPaise;
}

/** Ledger totals for settlement: excludes UNALLOCATED rows and payments in excludedPaymentIds. */
export function computeNetAllocatedLedgerTotals(entries, excludedPaymentIds = new Set()) {
  const filtered = entries.filter(
    (row) =>
      row.type !== "UNALLOCATED_PAYMENT"
      && (!row.paymentId || !excludedPaymentIds.has(String(row.paymentId))),
  );
  const totals = ledgerTotals(filtered);
  return {
    amountPaidPaise: Math.max(0, totals.amountPaidPaise),
    goldWeightMg: Math.max(0, totals.goldWeightMg),
  };
}

export async function loadExcludedPaymentIdsForLedgerEntries(entries, tenantId, session) {
  const paymentIds = [
    ...new Set(entries.map((row) => row.paymentId).filter(Boolean)),
  ];
  const excludedPaymentIds = new Set();
  if (!paymentIds.length) return excludedPaymentIds;
  const payments = await Payment.find({
    _id: { $in: paymentIds },
    tenantId,
    status: {
      $in: [
        PaymentStatus.PENDING,
        PaymentStatus.FAILED,
        PaymentStatus.UNALLOCATED_PENDING_REVIEW,
        PaymentStatus.REVERSED,
      ],
    },
  })
    .select("_id")
    .session(session ?? null)
    .lean();
  for (const row of payments) excludedPaymentIds.add(String(row._id));
  return excludedPaymentIds;
}

export async function computeNetAllocatedPrincipalForScheme({
  tenantId,
  schemeId,
  session,
}) {
  const entries = await LedgerEntry.find({ tenantId, schemeId })
    .session(session)
    .lean();
  const paymentIds = [
    ...new Set(entries.map((row) => row.paymentId).filter(Boolean)),
  ];
  const excludedPaymentIds = new Set();
  if (paymentIds.length) {
    const payments = await Payment.find({
      _id: { $in: paymentIds },
      tenantId,
      status: {
        $in: [
          PaymentStatus.PENDING,
          PaymentStatus.FAILED,
          PaymentStatus.UNALLOCATED_PENDING_REVIEW,
          PaymentStatus.REVERSED,
        ],
      },
    })
      .select("_id")
      .session(session)
      .lean();
    for (const row of payments) excludedPaymentIds.add(String(row._id));
  }
  return computeNetAllocatedLedgerTotals(entries, excludedPaymentIds).amountPaidPaise;
}

export async function enqueueFlexPolicyClosedOutbox({
  session,
  tenantId,
  scheme,
  closeReason,
  settlementRequired,
}) {
  try {
    await OutboxEvent.create(
      [
        {
          tenantId,
          topic: "scheme.flex_policy.closed",
          key: `${scheme._id}:${closeReason}`,
          payload: {
            schemeId: scheme._id,
            customerId: scheme.customerId,
            branchId: scheme.branchId,
            closeReason,
            settlementRequired,
            enrollmentNumber: scheme.enrollmentNumber,
          },
        },
      ],
      { session },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
}

export async function upsertFlexSettlementAlert({
  session,
  tenantId,
  scheme,
  settlementPrincipalPaise,
}) {
  if (!(settlementPrincipalPaise > 0)) return;
  const { upsertOperationalAlert } = await import("./operational-alert.js");
  const { AlertSeverity, AlertType } = await import("../constants/enums.js");
  await upsertOperationalAlert({
    tenantId,
    type: AlertType.FLEX_SETTLEMENT_REQUIRED,
    entityId: scheme._id,
    severity: AlertSeverity.WARNING,
    title: "Flexible scheme settlement required",
    message:
      "This scheme was closed by flexible lock policy and requires staff settlement of the customer principal.",
    entityType: "SCHEME",
    metadata: {
      branchId: scheme.branchId,
      schemeId: scheme._id,
      customerId: scheme.customerId,
      closureReason: scheme.closureReason,
      settlementPrincipalPaise,
    },
    session,
  });
}

export async function applySystemFlexLockClosure({
  session,
  req,
  scheme,
  closeReason,
  netFreeTotalPaise,
  minTotalPaise,
}) {
  if (isFlexSystemPolicyClosure(scheme)) {
    return {
      ...scheme.toObject(),
      closeReason: scheme.closureReason,
      settlementRequired: scheme.settlementRequired,
      idempotent: true,
    };
  }

  const settlementPrincipalPaise = await computeNetAllocatedPrincipalForScheme({
    tenantId: scheme.tenantId,
    schemeId: scheme._id,
    session,
  });
  const settlementRequired = settlementPrincipalPaise > 0;
  const closedAt = new Date();
  const before = scheme.toObject();

  scheme.status = SchemeStatus.CLOSED_PREMATURE;
  scheme.closureReason = closeReason;
  scheme.closedAt = closedAt;
  scheme.settlementRequired = settlementRequired;
  scheme.settlementPrincipalPaise = settlementPrincipalPaise;
  scheme.settlementCompletedAt = undefined;
  scheme.positionVersion += 1;
  scheme.version += 1;
  await scheme.save({ session });

  const auditEventId = await writeAudit({
    req,
    action: "SCHEME_CLOSED_PREMATURE",
    entityType: AuditEntityType.SCHEME,
    entityId: scheme._id,
    before,
    after: scheme.toObject(),
    metadata: {
      closeReason,
      netFreeTotalPaise,
      minTotalPaise,
      settlementPrincipalPaise,
      settlementRequired,
      policySource: "FLEXIBLE_LOCK",
    },
    session,
  });

  await enqueueFlexPolicyClosedOutbox({
    session,
    tenantId: scheme.tenantId,
    scheme,
    closeReason,
    settlementRequired,
  });
  await upsertFlexSettlementAlert({
    session,
    tenantId: scheme.tenantId,
    scheme,
    settlementPrincipalPaise,
  });

  return {
    ...scheme.toObject(),
    closeReason,
    settlementRequired,
    settlementPrincipalPaise,
    auditEventId,
  };
}
