import { AuditEntityType, SchemePlanStatus } from "../constants/enums.js";
import { Scheme, SchemePlan } from "../models/index.js";
import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { writeAudit } from "./audit.service.js";
import { paginate } from "../lib/pagination.js";
import { buildSchedulePreview } from "./schedule.service.js";

export async function listPlans(req, consumer = "admin") {
  const filters = consumer === "admin" ? {} : { status: SchemePlanStatus.ACTIVE };
  if (consumer === "app") { filters["availability.visibleInCustomerApp"] = true; filters["availability.customerSelfEnrolAllowed"] = true; }
  if (req.scope?.branchId) filters.$or = [{ "availability.allBranches": true }, { "availability.branchIds": req.scope.branchId }];
  return paginate(SchemePlan, { scope: { tenantId: req.auth.tenantId }, filters, cursor: req.query.cursor, limit: req.query.limit, sort: req.query.sort ?? "createdAt:desc" });
}
export async function getPlan(req) { const plan = await SchemePlan.findOne({ _id: req.params.planId, tenantId: req.auth.tenantId }).lean(); if (!plan) throw errors.notFound("Scheme plan"); return plan; }
function rejectUnsupportedPlan(body) { if (body.flexibleRules?.extensionMode === "EXTEND_FLEXIBLE_PHASE") throw errors.business("UNSUPPORTED_PLAN_CONFIGURATION", "Flexible-phase extension is not supported and cannot be saved."); }
export async function createPlan(req) { rejectUnsupportedPlan(req.body); return withTransaction(async (session) => { const plan = (await SchemePlan.create([{ _id: createId("plan"), tenantId: req.auth.tenantId, ...req.body, createdBy: req.auth.id }], { session }))[0]; const auditEventId = await writeAudit({ req, action: "PLAN_CREATED", entityType: AuditEntityType.PLAN, entityId: plan._id, after: plan.toObject(), session }); return { ...plan.toObject(), auditEventId }; }); }
export async function updatePlan(req) {
  rejectUnsupportedPlan(req.body);
  return withTransaction(async (session) => {
    const plan = await SchemePlan.findOne({ _id: req.params.planId, tenantId: req.auth.tenantId }).session(session); if (!plan) throw errors.notFound("Scheme plan");
    if (req.body.expectedVersion !== plan.version) throw new AppError("VERSION_CONFLICT", "This plan changed. Refresh and try again.", 409);
    const activeCount = await Scheme.countDocuments({ tenantId: plan.tenantId, planId: plan._id, status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED"] } }).session(session);
    const immutable = ["valueBasis", "paymentPattern", "durationMonths", "installmentCount", "amountRules", "scheduleRules", "paymentRules", "flexibleRules", "benefit", "redemptionRules"];
    if (activeCount && immutable.some((key) => req.body[key] !== undefined)) throw new AppError("PLAN_HAS_ACTIVE_ENROLMENTS", "Financial rules cannot be changed while the plan has active enrolments.", 409);
    const before = plan.toObject(); const patch = { ...req.body }; delete patch.expectedVersion; Object.assign(plan, patch); plan.version += 1; await plan.save({ session });
    const auditEventId = await writeAudit({ req, action: "PLAN_UPDATED", entityType: AuditEntityType.PLAN, entityId: plan._id, before, after: plan.toObject(), session }); return { ...plan.toObject(), auditEventId };
  });
}
export async function setPlanStatus(req, status) { return withTransaction(async (session) => { const plan = await SchemePlan.findOneAndUpdate({ _id: req.params.planId, tenantId: req.auth.tenantId }, { $set: { status }, $inc: { version: 1 } }, { new: true, session }); if (!plan) throw errors.notFound("Scheme plan"); const auditEventId = await writeAudit({ req, action: status === SchemePlanStatus.ACTIVE ? "PLAN_ACTIVATED" : "PLAN_DEACTIVATED", entityType: AuditEntityType.PLAN, entityId: plan._id, after: plan.toObject(), session }); return { id: plan._id, status, version: plan.version, auditEventId }; }); }
export async function duplicatePlan(req) { const source = await getPlan(req); delete source._id; delete source.createdAt; delete source.updatedAt; source.code = `${source.code}_COPY_${Date.now().toString().slice(-4)}`; source.name = `${source.name} Copy`; source.status = SchemePlanStatus.DRAFT; source.version = 1; req.body = source; return createPlan(req); }
export async function planStats(req) { const plan = await getPlan(req); const [active, completed, total] = await Promise.all([Scheme.countDocuments({ tenantId: req.auth.tenantId, planId: plan._id, status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED"] } }), Scheme.countDocuments({ tenantId: req.auth.tenantId, planId: plan._id, status: { $in: ["REDEEMED", "CLOSED_PREMATURE"] } }), Scheme.countDocuments({ tenantId: req.auth.tenantId, planId: plan._id })]); return { planId: plan._id, active, completed, total }; }
export const previewSchedule = (body) => buildSchedulePreview(body);
