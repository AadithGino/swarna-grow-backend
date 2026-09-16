import { Customer, LedgerEntry } from "../../models/index.js";
import { AppError } from "../../lib/app-error.js";
import { moneyRef } from "../../lib/money.js";
import { dateMatch } from "../../lib/query-filters.js";
import { paginate } from "../../lib/pagination.js";
import { baseEnvelope } from "./report-envelope.js";

const COLUMNS = [
  { key: "date", label: "Date", type: "date", sticky: true },
  { key: "description", label: "Description", type: "text" },
  { key: "debit", label: "Debit", type: "currency", align: "right" },
  { key: "credit", label: "Credit", type: "currency", align: "right" },
  { key: "balance", label: "Balance", type: "currency", align: "right", emphasis: true },
];

const CREDIT_TYPES = new Set(["INSTALLMENT_PAYMENT", "FREE_WINDOW_PAYMENT", "UNALLOCATED_PAYMENT", "BENEFIT_CREDIT", "ADJUSTMENT"]);

function signedAmount(entry) {
  const amount = entry.amountPaise ?? 0;
  if (entry.type === "REVERSAL" || entry.type === "REDEMPTION_DEBIT" || entry.type === "CLOSURE_PENALTY") {
    return -Math.abs(amount);
  }
  if (CREDIT_TYPES.has(entry.type)) return Math.abs(amount);
  return amount;
}

export async function buildCustomerLedgerReport(req) {
  const customerId = req.query.customerId;
  if (!customerId) {
    throw new AppError("CUSTOMER_ID_REQUIRED", "customerId query parameter is required for the customer ledger report.", 422);
  }

  const customer = await Customer.findOne({ _id: customerId, ...req.scope }).select("_id name customerNumber").lean();
  if (!customer) throw new AppError("CUSTOMER_NOT_FOUND", "Customer not found in this scope.", 404);

  const envelope = baseEnvelope(req, "CUSTOMER_LEDGER", `Customer ledger — ${customer.name}`);
  const { from, to } = envelope.period;

  const openingEntries = await LedgerEntry.find({
    tenantId: req.auth.tenantId,
    customerId,
    ...(from
      ? { effectiveAt: { $lt: new Date(`${from}T00:00:00+05:30`) } }
      : {}),
  })
    .select("type amountPaise")
    .lean();

  let running = openingEntries.reduce((sum, entry) => sum + signedAmount(entry), 0);
  const openingBalance = running;

  const page = await paginate(LedgerEntry, {
    scope: { tenantId: req.auth.tenantId, customerId },
    filters: dateMatch("effectiveAt", { from, to }),
    cursor: req.query.cursor,
    limit: req.query.limit ?? 50,
    sort: "effectiveAt:asc",
  });

  let creditsInPeriod = 0;
  const rows = page.data.map((entry) => {
    const delta = signedAmount(entry);
    if (delta > 0) creditsInPeriod += delta;
    running += delta;
    const credit = delta > 0 ? delta : 0;
    const debit = delta < 0 ? -delta : 0;
    return {
      key: entry._id,
      date: entry.effectiveAt ? new Date(entry.effectiveAt).toISOString().slice(0, 10) : null,
      description: entry.description ?? entry.type,
      debit: moneyRef(debit),
      credit: moneyRef(credit),
      balance: moneyRef(running),
    };
  });

  return {
    ...envelope,
    summary: [
      { key: "OPENING", label: "Opening balance", value: moneyRef(Math.max(0, openingBalance)), valueType: "currency" },
      { key: "CREDITS", label: "Credits", value: moneyRef(creditsInPeriod), valueType: "currency" },
      { key: "CLOSING", label: "Closing balance", value: moneyRef(Math.max(0, running)), valueType: "currency" },
    ],
    charts: {},
    columns: COLUMNS,
    rows,
    meta: page.meta,
  };
}
