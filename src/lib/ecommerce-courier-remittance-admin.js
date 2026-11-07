import { EcommerceCodRemittanceLineStatus } from "../constants/enums.js";
import { errors } from "./app-error.js";
import {
  assertAdminEcommerceOrderInScope,
  ecommerceAdminRoleScope,
  filterOrderIdsInAdminBranchScope,
} from "./ecommerce-admin-order-scope.js";
import { EcommerceCodRemittanceLine, EcommerceOrder } from "../models/index.js";

const ACTIVE_LINE = EcommerceCodRemittanceLineStatus.ACTIVE;

/** All lines in a batch (any status) — branch read scope and mixed-batch disclosure. */
export async function loadAllRemittanceLinesForBatch(tenantId, batchId, { session } = {}) {
  const query = EcommerceCodRemittanceLine.find({ tenantId, batchId });
  if (session) query.session(session);
  return query.lean();
}

/** ACTIVE lines only — remittance mutations (reconcile, add line, etc.). */
export async function loadRemittanceLinesForBatch(tenantId, batchId, { session } = {}) {
  const query = EcommerceCodRemittanceLine.find({
    tenantId,
    batchId,
    status: ACTIVE_LINE,
  });
  if (session) query.session(session);
  return query.lean();
}

/** Branch managers may not mutate batches that include foreign-branch orders. */
export async function assertRemittanceBatchMutationScope(req, batchId, { session } = {}) {
  if (ecommerceAdminRoleScope(req) === "TENANT") return;
  const lines = await loadRemittanceLinesForBatch(req.auth.tenantId, batchId, { session });
  if (!lines.length) return;
  const orderIds = lines.map((line) => line.orderId);
  const allowed = await filterOrderIdsInAdminBranchScope(req, orderIds);
  if (allowed.length !== orderIds.length) {
    throw errors.forbidden("Remittance batch includes orders outside your branch scope.");
  }
}

export async function assertOrderInRemittanceMutationScope(req, order, { session } = {}) {
  if (session) {
    const fresh = await EcommerceOrder.findOne({ _id: order._id, tenantId: order.tenantId }).session(session).lean();
    if (!fresh) throw errors.notFound("Order");
    await assertAdminEcommerceOrderInScope(req, fresh);
    return fresh;
  }
  await assertAdminEcommerceOrderInScope(req, order);
  return order;
}

/** Strip whole-batch bank fields when the caller only sees a branch subset of lines. */
export function branchScopedRemittanceBatchDto(batch, {
  visibleLines,
  totalLineCount,
  branchScoped,
}) {
  if (!branchScoped) {
    return { ...batch, branchScopedView: false };
  }
  const grossExpectedPaise = visibleLines.reduce((sum, line) => sum + (line.grossPaise ?? 0), 0);
  const feePaise = visibleLines.reduce((sum, line) => sum + (line.feePaise ?? 0), 0);
  const partialBatch = totalLineCount > visibleLines.length;
  return {
    _id: batch._id,
    tenantId: batch.tenantId,
    providerId: batch.providerId ?? null,
    status: batch.status,
    importSource: batch.importSource ?? null,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    createdByUserId: batch.createdByUserId ?? null,
    grossExpectedPaise,
    feePaise,
    netExpectedPaise: grossExpectedPaise - feePaise,
    lineCount: visibleLines.length,
    branchScopedView: true,
    mixedBatch: partialBatch,
    ...(partialBatch
      ? {}
      : {
        statementReference: batch.statementReference ?? null,
        bankCreditReference: batch.bankCreditReference ?? null,
        bankCreditPaise: batch.bankCreditPaise ?? null,
        bankCreditedAt: batch.bankCreditedAt ?? null,
        reconciliationStatus: batch.reconciliationStatus ?? null,
        reconciliationNote: batch.reconciliationNote ?? null,
        finalizedAt: batch.finalizedAt ?? null,
      }),
  };
}
