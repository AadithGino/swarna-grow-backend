/**
 * Helpers for trades staff place for a customer at the counter (Digi Gold buy/sell, store orders).
 *
 * - `customerBoundRequest` builds a request object that looks like the customer's own request, so the
 *   existing customer services (quotes, orders, terms, stock, tax) run unchanged.
 * - `postCounterCash` records cash taken in (CREDIT) or paid out (DEBIT) against the staff member's
 *   cash custody, once per source record. Owners/admins are not cash custodians, so nothing is posted
 *   for them and the caller reports `cashCustody: "OWNER"`.
 */
import { CashAdjustmentDirection, TenantRole } from "../constants/enums.js";
import { CashAdjustment, CashStaffCustody } from "../models/index.js";
import { createId } from "./ids.js";
import { errors } from "./app-error.js";

const CASH_CUSTODY_ROLES = new Set([
  TenantRole.BRANCH_MANAGER,
  TenantRole.BRANCH_STAFF,
  TenantRole.COLLECTION_AGENT,
]);

export const COUNTER_PAYMENT_MODES = ["CASH", "UPI", "CARD"];

export function customerBoundRequest(req, customer, { idempotencyKey, body = {}, params = {} } = {}) {
  return {
    auth: {
      tenantId: req.auth.tenantId,
      id: String(customer._id),
      type: "CUSTOMER",
      subject: "CUSTOMER",
      role: null,
      permissions: [],
    },
    tenant: req.tenant,
    scope: {},
    query: {},
    params,
    body,
    headers: { "x-idempotency-key": idempotencyKey ?? "" },
    traceId: req.traceId,
    ip: req.ip,
  };
}

/** Stable per-request key for the inner steps; keeps each step replay-safe when the client retries. */
export function counterStepKey(req, step) {
  const base = String(req.headers?.["x-idempotency-key"] ?? "").trim();
  if (!base) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  return `ctr:${base}:${step}`.slice(0, 80);
}

export function assertCustomerCanTradeAtCounter(customer) {
  if (!customer) throw errors.notFound("Customer");
  if (customer.status && customer.status !== "ACTIVE") {
    throw errors.business(
      "CUSTOMER_NOT_ACTIVE",
      "This customer is blocked or inactive. Reactivate the customer before placing a trade.",
    );
  }
}

export function counterBranchId(req, customer) {
  return req.scope?.branchId ?? req.auth?.branchId ?? customer?.branchId ?? null;
}

export function assistedMetadata(req, customer, extras = {}) {
  return {
    channel: "COUNTER",
    byUserId: req.auth.id,
    byRole: req.auth.role ?? null,
    branchId: counterBranchId(req, customer),
    recordedAt: new Date(),
    ...extras,
  };
}

export function isCashCustodian(req) {
  return CASH_CUSTODY_ROLES.has(req.auth?.role);
}

/**
 * @returns {Promise<{ cashAdjustmentId: string | null, cashCustody: "STAFF" | "OWNER" }>}
 */
export async function postCounterCash(session, { req, customer, direction, amountPaise, reason, sourceType, sourceId }) {
  if (!isCashCustodian(req)) return { cashAdjustmentId: null, cashCustody: "OWNER" };
  const tenantId = req.auth.tenantId;
  const existing = await CashAdjustment.findOne({ tenantId, sourceType, sourceId }).session(session).lean();
  if (existing) return { cashAdjustmentId: existing._id, cashCustody: "STAFF" };
  const branchId = counterBranchId(req, customer);
  const staffId = req.auth.id;
  await CashStaffCustody.findOneAndUpdate(
    { tenantId, branchId, staffId },
    { $inc: { version: 1 }, $setOnInsert: { _id: createId("csc"), tenantId, branchId, staffId } },
    { upsert: true, session },
  );
  const [row] = await CashAdjustment.create(
    [
      {
        _id: createId("cad"),
        tenantId,
        branchId,
        staffId,
        direction: direction === "DEBIT" ? CashAdjustmentDirection.DEBIT : CashAdjustmentDirection.CREDIT,
        amountPaise,
        reason: String(reason).slice(0, 300),
        createdBy: req.auth.id,
        sourceType,
        sourceId,
      },
    ],
    { session },
  );
  return { cashAdjustmentId: row._id, cashCustody: "STAFF" };
}
