import { Payment } from "../models/index.js";
import { PAYMENT_MODE_LABELS, PAYMENT_MODE_ORDER } from "../constants/enums.js";
import { dateMatch, effectiveScope } from "../lib/query-filters.js";

const fillModes = (rows) =>
  PAYMENT_MODE_ORDER.filter((mode) => mode !== "LEGACY_ONLINE" || rows.some((row) => row._id === mode)).map((mode) => {
    const row = rows.find((item) => item._id === mode);
    return { mode, label: PAYMENT_MODE_LABELS[mode], amountPaise: row?.amountPaise ?? 0, count: row?.count ?? 0 };
  });

export async function collectionSummary(req) {
  const match = { ...effectiveScope(req), status: "SUCCESS", ...dateMatch("paidAt", req.query) };
  const [totals, modes] = await Promise.all([
    Payment.aggregate([{ $match: match }, { $group: { _id: null, amountPaise: { $sum: "$amountPaise" }, count: { $sum: 1 } } }]),
    Payment.aggregate([{ $match: match }, { $group: { _id: "$mode", amountPaise: { $sum: "$amountPaise" }, count: { $sum: 1 } } }]),
  ]);
  return { amountPaise: totals[0]?.amountPaise ?? 0, count: totals[0]?.count ?? 0, byMode: fillModes(modes) };
}
