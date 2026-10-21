import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { DigitalMetalProcurementEntry } from "../models/index.js";

function mapEntry(row) {
  const qty = Number(row.quantityUg ?? 0);
  const received = Number(row.receivedQuantityUg ?? 0);
  const remainingCommitmentUg =
    row.entryType === "COMMITMENT" && row.status === "APPROVED"
      ? String(Math.max(0, qty - received))
      : null;
  return {
    id: row._id,
    entryType: row.entryType,
    status: row.status,
    metal: row.metal,
    finenessPpm: row.finenessPpm,
    quantityUg: String(row.quantityUg),
    receivedQuantityUg: row.entryType === "COMMITMENT" ? String(received) : null,
    remainingCommitmentUg,
    obligationQuantityUg: row.obligationQuantityUg != null ? String(row.obligationQuantityUg) : null,
    amountPaise: row.amountPaise ?? 0,
    supplierRef: row.supplierRef ?? "",
    billRef: row.billRef ?? "",
    locationCode: row.locationCode ?? "PRIMARY",
    effectiveDate: row.effectiveDate,
    commitmentEntryId: row.commitmentEntryId ?? null,
    reversesEntryId: row.reversesEntryId ?? null,
    evidenceUploadIds: row.evidenceUploadIds ?? [],
    reasonNote: row.reasonNote ?? "",
    overReceiptApproved: row.overReceiptApproved ?? false,
    overReceiptApprovalNote: row.overReceiptApprovalNote ?? "",
    createdByUserId: row.createdByUserId,
    approvedByUserId: row.approvedByUserId ?? null,
    approvedAt: row.approvedAt ?? null,
    recordedAt: row.recordedAt ?? row.createdAt,
    version: row.version ?? 1,
  };
}

function assertAssetMatch(entry, { metal, finenessPpm, tenantId }) {
  if (entry.tenantId !== tenantId) throw errors.notFound("Procurement entry");
  if (entry.metal !== metal || Number(entry.finenessPpm) !== Number(finenessPpm)) {
    throw new AppError("ASSET_MISMATCH", "Linked entry metal/purity does not match.", 409);
  }
}

function validateReversalLink(entry, original) {
  if (!original) throw errors.notFound("Reversed entry");
  if (original.status !== "APPROVED") {
    throw new AppError("INVALID_STATE", "Can only reverse approved entries.", 409);
  }
  assertAssetMatch(original, entry);
  if (Number(entry.quantityUg) > Number(original.quantityUg)) {
    throw new AppError("REVERSAL_EXCEEDS_ORIGINAL", "Reversal quantity exceeds original.", 409);
  }
}

export async function createProcurementEntry(req) {
  const body = req.body;
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Required." }]);
  }
  const existing = await DigitalMetalProcurementEntry.findOne({
    tenantId: req.auth.tenantId,
    idempotencyKey,
  }).lean();
  if (existing) return mapEntry(existing);

  if (body.entryType === "RECEIPT" && body.commitmentEntryId) {
    const commitment = await DigitalMetalProcurementEntry.findOne({
      _id: body.commitmentEntryId,
      tenantId: req.auth.tenantId,
      entryType: "COMMITMENT",
      status: "APPROVED",
    }).lean();
    if (!commitment) throw errors.notFound("Commitment");
    assertAssetMatch(commitment, {
      tenantId: req.auth.tenantId,
      metal: body.metal,
      finenessPpm: body.finenessPpm,
    });
  }

  if (body.entryType === "REVERSAL") {
    if (!body.reversesEntryId) {
      throw errors.validation([{ field: "reversesEntryId", message: "Required for reversals." }]);
    }
    const original = await DigitalMetalProcurementEntry.findOne({
      _id: body.reversesEntryId,
      tenantId: req.auth.tenantId,
    }).lean();
    validateReversalLink(
      { tenantId: req.auth.tenantId, metal: body.metal, finenessPpm: body.finenessPpm, quantityUg: body.quantityUg },
      original,
    );
  }

  const row = await DigitalMetalProcurementEntry.create({
    _id: createId("dmpce"),
    tenantId: req.auth.tenantId,
    entryType: body.entryType,
    status: "PENDING_APPROVAL",
    metal: body.metal,
    finenessPpm: body.finenessPpm,
    quantityUg: body.quantityUg,
    obligationQuantityUg: body.obligationQuantityUg ?? null,
    amountPaise: body.amountPaise ?? 0,
    supplierRef: body.supplierRef ?? "",
    billRef: body.billRef ?? "",
    locationCode: body.locationCode ?? "PRIMARY",
    effectiveDate: body.effectiveDate,
    commitmentEntryId: body.commitmentEntryId ?? null,
    reversesEntryId: body.reversesEntryId ?? null,
    evidenceUploadIds: (body.evidenceUploadIds ?? []).slice(0, 10),
    reasonNote: body.reasonNote ?? "",
    overReceiptApproved: body.overReceiptApproved === true,
    overReceiptApprovalNote: body.overReceiptApprovalNote ?? "",
    createdByUserId: req.auth.id,
    idempotencyKey,
  });
  return mapEntry(row.toObject());
}

export async function approveProcurementEntry(req) {
  const overReceiptApprove = req.body?.overReceiptApprove === true;
  const overReceiptApprovalNote = String(req.body?.overReceiptApprovalNote ?? "").trim();

  return withTransaction(async (session) => {
    const entry = await DigitalMetalProcurementEntry.findOne({
      _id: req.params.id,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!entry) throw errors.notFound("Procurement entry");
    if (entry.status === "APPROVED") return mapEntry(entry.toObject());
    if (entry.status !== "PENDING_APPROVAL") {
      throw new AppError("INVALID_STATE", "Entry is not pending approval.", 409);
    }
    if (entry.createdByUserId === req.auth.id) {
      throw new AppError("MAKER_CHECKER", "Approver must differ from creator.", 403);
    }
    if (["OPENING_POSITION", "REVERSAL"].includes(entry.entryType) && !(entry.evidenceUploadIds?.length > 0)) {
      throw errors.validation([{ field: "evidenceUploadIds", message: "Evidence required." }]);
    }

    if (entry.entryType === "RECEIPT" && entry.commitmentEntryId) {
      const qty = Number(entry.quantityUg);
      const allowOver = overReceiptApprove || entry.overReceiptApproved;
      if (allowOver && !overReceiptApprovalNote && !entry.overReceiptApprovalNote) {
        throw errors.validation([
          { field: "overReceiptApprovalNote", message: "Required when approving over-receipt." },
        ]);
      }
      if (allowOver) {
        entry.overReceiptApproved = true;
        entry.overReceiptApprovalNote = overReceiptApprovalNote || entry.overReceiptApprovalNote;
      }
      const filter = {
        _id: entry.commitmentEntryId,
        tenantId: req.auth.tenantId,
        entryType: "COMMITMENT",
        status: "APPROVED",
        metal: entry.metal,
        finenessPpm: entry.finenessPpm,
      };
      if (!allowOver) {
        filter.$expr = {
          $lte: [{ $add: [{ $ifNull: ["$receivedQuantityUg", 0] }, qty] }, "$quantityUg"],
        };
      }
      const commitment = await DigitalMetalProcurementEntry.findOneAndUpdate(
        filter,
        { $inc: { receivedQuantityUg: qty } },
        { session, new: true },
      );
      if (!commitment) {
        if (allowOver) throw errors.notFound("Commitment");
        throw new AppError("RECEIPT_EXCEEDS_COMMITMENT", "Receipt exceeds commitment quantity.", 409);
      }
    }

    if (entry.entryType === "REVERSAL") {
      const original = await DigitalMetalProcurementEntry.findOne({
        _id: entry.reversesEntryId,
        tenantId: req.auth.tenantId,
      }).session(session);
      validateReversalLink(entry, original);
      const priorReversals = await DigitalMetalProcurementEntry.find({
        tenantId: req.auth.tenantId,
        entryType: "REVERSAL",
        status: "APPROVED",
        reversesEntryId: original._id,
      })
        .session(session)
        .lean();
      const reversedQty = priorReversals.reduce((s, r) => s + Number(r.quantityUg), 0);
      if (reversedQty + Number(entry.quantityUg) > Number(original.quantityUg)) {
        throw new AppError("REVERSAL_EXCEEDS_ORIGINAL", "Cumulative reversals exceed original quantity.", 409);
      }
      if (original.entryType === "RECEIPT" && original.commitmentEntryId) {
        await DigitalMetalProcurementEntry.updateOne(
          { _id: original.commitmentEntryId, tenantId: req.auth.tenantId },
          { $inc: { receivedQuantityUg: -Number(entry.quantityUg) } },
          { session },
        );
      }
    }

    entry.status = "APPROVED";
    entry.approvedByUserId = req.auth.id;
    entry.approvedAt = new Date();
    entry.version = (entry.version ?? 1) + 1;
    await entry.save({ session });
    return mapEntry(entry.toObject());
  });
}

export async function listProcurementEntries(req) {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const filter = { tenantId: req.auth.tenantId };
  if (req.query.entryType) filter.entryType = req.query.entryType;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.metal) filter.metal = req.query.metal;
  if (req.query.commitmentEntryId) filter.commitmentEntryId = req.query.commitmentEntryId;
  if (req.query.cursor) {
    filter._id = { $lt: String(req.query.cursor) };
  }
  const rows = await DigitalMetalProcurementEntry.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(mapEntry),
    nextCursor: hasMore ? page[page.length - 1]._id : null,
  };
}

export async function getProcurementEntry(req) {
  const row = await DigitalMetalProcurementEntry.findOne({
    _id: req.params.id,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!row) throw errors.notFound("Procurement entry");
  const related = await DigitalMetalProcurementEntry.find({
    tenantId: req.auth.tenantId,
    $or: [
      { commitmentEntryId: row._id },
      { reversesEntryId: row._id },
      ...(row.commitmentEntryId ? [{ _id: row.commitmentEntryId }] : []),
      ...(row.reversesEntryId ? [{ _id: row.reversesEntryId }] : []),
    ],
  })
    .sort({ effectiveDate: -1 })
    .limit(50)
    .lean();
  return {
    ...mapEntry(row),
    relatedEntries: related.filter((r) => r._id !== row._id).map(mapEntry),
  };
}
