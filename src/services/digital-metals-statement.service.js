import { errors } from "../lib/app-error.js";
import { istBusinessDayBounds } from "../lib/digital-metals-business-calendar.js";
import { Customer, DigitalMetalJournal, DigitalMetalWallet } from "../models/index.js";

async function journalBalancesAtCutoff(tenantId, customerId, cutoffEnd) {
  const wallets = await DigitalMetalWallet.find({ tenantId, customerId }).lean();
  const byAsset = [];
  for (const w of wallets) {
    const journals = await DigitalMetalJournal.find({
      tenantId,
      walletId: w._id,
      createdAt: { $lte: cutoffEnd },
    })
      .sort({ sequence: 1 })
      .lean();
    let heldUg = 0;
    let reservedUg = 0;
    for (const j of journals) {
      heldUg += j.quantityUgDelta ?? 0;
      reservedUg += j.reservedUgDelta ?? 0;
    }
    byAsset.push({
      metal: w.metal,
      finenessPpm: w.finenessPpm,
      heldUg: String(heldUg),
      reservedUg: String(reservedUg),
      availableUg: String(Math.max(0, heldUg - reservedUg)),
    });
  }
  return byAsset;
}

export async function buildMetalStatementSnapshot({
  tenantId,
  customerId,
  fromBusinessDate,
  toBusinessDate,
}) {
  const from = String(fromBusinessDate ?? "").trim();
  const to = String(toBusinessDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw errors.validation([
      { field: "fromBusinessDate", message: "Required YYYY-MM-DD." },
      { field: "toBusinessDate", message: "Required YYYY-MM-DD." },
    ]);
  }
  if (to < from) {
    throw errors.validation([{ field: "toBusinessDate", message: "Must be on or after fromBusinessDate." }]);
  }

  const customer = await Customer.findOne({ _id: customerId, tenantId }).lean();
  if (!customer) throw errors.notFound("Customer");

  const { start: periodStart } = istBusinessDayBounds(from);
  const { end: periodEnd } = istBusinessDayBounds(to);

  const walletIds = (
    await DigitalMetalWallet.find({ tenantId, customerId }).select("_id").lean()
  ).map((w) => w._id);

  const openingCutoff = new Date(periodStart.getTime() - 1);
  const openingByAsset = await journalBalancesAtCutoff(tenantId, customerId, openingCutoff);
  const closingByAsset = await journalBalancesAtCutoff(tenantId, customerId, periodEnd);

  const lines = await DigitalMetalJournal.find({
    tenantId,
    walletId: { $in: walletIds },
    createdAt: { $gte: periodStart, $lte: periodEnd },
  })
    .sort({ sequence: 1 })
    .lean();

  return {
    fromBusinessDate: from,
    toBusinessDate: to,
    journalCutoffAt: periodEnd.toISOString(),
    openingByAsset,
    closingByAsset,
    activity: lines.map((r) => ({
      id: r._id,
      entryType: r.entryType,
      quantityUgDelta: String(r.quantityUgDelta),
      reservedUgDelta: String(r.reservedUgDelta ?? 0),
      createdAt: r.createdAt,
      referenceType: r.referenceType ?? null,
      referenceId: r.referenceId ?? null,
    })),
  };
}

export async function buildCustomerMetalStatement(req) {
  return buildMetalStatementSnapshot({
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
    fromBusinessDate: req.query.fromBusinessDate,
    toBusinessDate: req.query.toBusinessDate,
  });
}

export async function streamCustomerMetalStatementPdf(req, res) {
  const from = String(req.query.fromBusinessDate ?? "").trim();
  const to = String(req.query.toBusinessDate ?? "").trim();
  const { streamMetalStatementPdf } = await import("./digital-metals-document.service.js");
  return streamMetalStatementPdf(req, res, {
    fromBusinessDate: from,
    toBusinessDate: to,
    customerId: req.auth.id,
  });
}
