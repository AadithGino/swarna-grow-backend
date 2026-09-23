import { Payment } from "../models/index.js";
import { PAYMENT_MODE_LABELS, PAYMENT_MODE_ORDER, TenantRole } from "../constants/enums.js";
import { dateMatch, resolveQueryDateRange } from "../lib/query-filters.js";
import { paymentListScope } from "../lib/payment-scope.js";
import {
  netCollectionStatusFilter,
  sumNetAmountPaise,
} from "../lib/payment-net-aggregation.js";

const fillModes = (rows) =>
  PAYMENT_MODE_ORDER.filter((mode) => mode !== "LEGACY_ONLINE" || rows.some((row) => row._id === mode)).map((mode) => {
    const row = rows.find((item) => item._id === mode);
    return { mode, label: PAYMENT_MODE_LABELS[mode], amountPaise: row?.amountPaise ?? 0, count: row?.count ?? 0 };
  });

export async function collectionSummary(req) {
  const range = resolveQueryDateRange(req.query);
  const match = {
    ...(await paymentListScope(req)),
    ...netCollectionStatusFilter(),
    ...dateMatch("paidAt", range),
  };
  if (req.auth?.role === TenantRole.COLLECTION_AGENT) {
    match.collectedBy = req.auth.id;
  }
  const [totals, modes] = await Promise.all([
    Payment.aggregate([{ $match: match }, { $group: { _id: null, amountPaise: sumNetAmountPaise(), count: { $sum: 1 } } }]),
    Payment.aggregate([{ $match: match }, { $group: { _id: "$mode", amountPaise: sumNetAmountPaise(), count: { $sum: 1 } } }]),
  ]);
  return { amountPaise: totals[0]?.amountPaise ?? 0, count: totals[0]?.count ?? 0, byMode: fillModes(modes) };
}
