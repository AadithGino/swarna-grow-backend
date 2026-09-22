import { createHash } from "node:crypto";
import { AlertType, PaymentMode, PaymentStatus } from "../constants/enums.js";
import { upsertOperationalAlert } from "../lib/operational-alert.js";
import { errors } from "../lib/app-error.js";
import { createId } from "../lib/ids.js";
import { withTransaction } from "../lib/transaction.js";
import { Payment, PaymentRefund, SettlementItem, SettlementRun, Tenant } from "../models/index.js";
import { SettlementRunStatus, SettlementSourceType } from "../models/gateway-settlement.models.js";
import { GatewayRefundStatus } from "../constants/enums.js";

function istBusinessDate(date = new Date()) {
  const ist = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const y = ist.getFullYear();
  const m = String(ist.getMonth() + 1).padStart(2, "0");
  const d = String(ist.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function checksumPayload(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function runDailyGatewaySettlementForTenant({
  tenantId,
  businessDate = istBusinessDate(),
  leaseOwner = "scheduler",
}) {
  let claimed = await SettlementRun.findOne({ tenantId, businessDate, provider: "PHONEPE" });
  if (!claimed) {
    claimed = await SettlementRun.create({
      _id: createId("stl"),
      tenantId,
      businessDate,
      provider: "PHONEPE",
      sourceType: SettlementSourceType.UPLOAD,
      status: SettlementRunStatus.RUNNING,
      startedAt: new Date(),
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 15 * 60_000),
    });
  } else if (claimed.leaseExpiresAt && claimed.leaseExpiresAt > new Date()) {
    return { outcome: "LEASE_BUSY", runId: claimed._id };
  } else {
    claimed = await SettlementRun.findOneAndUpdate(
      { _id: claimed._id },
      {
        $set: {
          leaseOwner,
          leaseExpiresAt: new Date(Date.now() + 15 * 60_000),
          status: SettlementRunStatus.RUNNING,
          startedAt: new Date(),
        },
      },
      { new: true },
    );
  }

  const from = new Date(`${businessDate}T00:00:00+05:30`);
  const to = new Date(`${businessDate}T23:59:59.999+05:30`);
  const captures = await Payment.find({
    tenantId,
    mode: PaymentMode.ONLINE_GATEWAY,
    status: { $in: [PaymentStatus.SUCCESS, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REVERSED] },
    paidAt: { $gte: from, $lte: to },
  }).select("_id amountPaise refundedAmountPaise providerTransactionId").lean();
  const refunds = await PaymentRefund.find({
    tenantId,
    status: GatewayRefundStatus.COMPLETED,
    completedAt: { $gte: from, $lte: to },
  }).select("_id paymentId amountPaise providerRefundId").lean();

  const expectedCapturePaise = captures.reduce(
    (sum, row) => sum + row.amountPaise - (row.refundedAmountPaise ?? 0),
    0,
  );
  const expectedRefundPaise = refunds.reduce((sum, row) => sum + row.amountPaise, 0);

  const uploadItems = await SettlementItem.find({ tenantId, runId: claimed._id }).lean();
  if (!uploadItems.length) {
    await SettlementRun.updateOne(
      { _id: claimed._id },
      {
        $set: {
          status: SettlementRunStatus.MISSING_STATEMENT,
          expectedCapturePaise,
          expectedRefundPaise,
          completedAt: new Date(),
        },
      },
    );
    await upsertOperationalAlert({
      tenantId,
      type: AlertType.GATEWAY_SETTLEMENT_MISSING,
      entityId: `${claimed._id}:${businessDate}`,
      title: "PhonePe settlement statement missing",
      message: `No settlement upload exists for business date ${businessDate}.`,
      metadata: { businessDate },
    });
    return { outcome: "MISSING_STATEMENT", runId: claimed._id };
  }

  let providerCapturePaise = 0;
  let providerRefundPaise = 0;
  const mismatches = [];
  for (const item of uploadItems) {
    if (item.providerRefundId) {
      providerRefundPaise += item.settledAmountPaise ?? 0;
      const match = refunds.find((row) => row.providerRefundId === item.providerRefundId);
      if (!match) mismatches.push({ itemId: item._id, reason: "UNKNOWN_REFUND" });
      else if (match.amountPaise !== item.settledAmountPaise) {
        mismatches.push({ itemId: item._id, reason: "REFUND_AMOUNT_MISMATCH" });
      }
    } else {
      providerCapturePaise += item.settledAmountPaise ?? 0;
      const match = captures.find(
        (row) => row.providerTransactionId === item.providerTransactionId
          || row._id === item.matchedPaymentId,
      );
      if (!match) mismatches.push({ itemId: item._id, reason: "UNKNOWN_CAPTURE" });
      else if ((match.amountPaise - (match.refundedAmountPaise ?? 0)) !== item.settledAmountPaise) {
        mismatches.push({ itemId: item._id, reason: "CAPTURE_AMOUNT_MISMATCH" });
      }
    }
  }

  const status = mismatches.length
    ? SettlementRunStatus.MISMATCH
    : SettlementRunStatus.MATCHED;
  await SettlementRun.updateOne(
    { _id: claimed._id },
    {
      $set: {
        status,
        expectedCapturePaise,
        expectedRefundPaise,
        providerCapturePaise,
        providerRefundPaise,
        mismatchCapturePaise: providerCapturePaise - expectedCapturePaise,
        mismatchRefundPaise: providerRefundPaise - expectedRefundPaise,
        completedAt: new Date(),
      },
    },
  );
  if (status === SettlementRunStatus.MISMATCH) {
    await upsertOperationalAlert({
      tenantId,
      type: AlertType.GATEWAY_SETTLEMENT_MISMATCH,
      entityId: claimed._id,
      title: "PhonePe settlement mismatch",
      message: "Uploaded settlement totals or line items did not match gateway captures/refunds.",
      metadata: { businessDate, mismatchCount: mismatches.length },
    });
  }
  return { outcome: status, runId: claimed._id, mismatches: mismatches.length };
}

export async function uploadGatewaySettlementStatement(req) {
  const businessDate = String(req.body.businessDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw errors.business("SETTLEMENT_DATE_INVALID", "businessDate must be YYYY-MM-DD.");
  }
  const rows = req.body.items;
  if (!Array.isArray(rows) || !rows.length) {
    throw errors.business("SETTLEMENT_ITEMS_REQUIRED", "items array is required.");
  }
  const checksum = checksumPayload({ businessDate, rows });
  let run = await SettlementRun.findOne({
    tenantId: req.auth.tenantId,
    businessDate,
    provider: "PHONEPE",
  });
  if (run?.inputChecksum === checksum) {
    return { runId: run._id, duplicate: true };
  }
  await withTransaction(async (session) => {
    if (!run) {
      const created = await SettlementRun.create(
        [
          {
            _id: createId("stl"),
            tenantId: req.auth.tenantId,
            businessDate,
            provider: "PHONEPE",
            sourceType: SettlementSourceType.UPLOAD,
            status: SettlementRunStatus.PENDING,
            inputChecksum: checksum,
          },
        ],
        { session },
      );
      run = created[0];
    } else {
      await SettlementItem.deleteMany({ tenantId: req.auth.tenantId, runId: run._id }).session(session);
      await SettlementRun.updateOne(
        { _id: run._id },
        { $set: { inputChecksum: checksum, status: SettlementRunStatus.PENDING } },
      ).session(session);
    }
    await SettlementItem.insertMany(
      rows.map((row) => ({
        _id: createId("sti"),
        tenantId: req.auth.tenantId,
        runId: run._id,
        providerTransactionId: row.providerTransactionId,
        providerRefundId: row.providerRefundId,
        expectedAmountPaise: row.expectedAmountPaise,
        settledAmountPaise: row.settledAmountPaise,
        matchedPaymentId: row.matchedPaymentId,
        matchedRefundId: row.matchedRefundId,
      })),
      { session },
    );
  });
  return { runId: run._id, duplicate: false };
}

export async function listSettlementRuns(req) {
  return SettlementRun.find({ tenantId: req.auth.tenantId })
    .sort({ businessDate: -1 })
    .limit(Number(req.query.limit ?? 30))
    .lean();
}

export async function getSettlementRun(req) {
  const run = await SettlementRun.findOne({
    _id: req.params.runId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!run) throw errors.notFound("Settlement run");
  const items = await SettlementItem.find({ tenantId: req.auth.tenantId, runId: run._id }).lean();
  return { ...run, items };
}

export async function runDailyGatewaySettlementBatch() {
  const tenants = await Tenant.find({ status: "ACTIVE" }).select("_id").lean();
  let processed = 0;
  for (const tenant of tenants) {
    try {
      await runDailyGatewaySettlementForTenant({ tenantId: tenant._id });
      processed += 1;
    } catch {
      await upsertOperationalAlert({
        tenantId: tenant._id,
        type: AlertType.GATEWAY_SETTLEMENT_FAILURE,
        entityId: istBusinessDate(),
        title: "PhonePe settlement run failed",
        message: "Daily settlement verification failed for this tenant.",
        metadata: { businessDate: istBusinessDate() },
      });
    }
  }
  return { processed, tenants: tenants.length };
}
