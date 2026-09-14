import crypto from "node:crypto";
import argon2 from "argon2";
import { AuditEntityType, TenantRole, UserStatus, UserType } from "../constants/enums.js";
import { ROLE_PERMISSIONS } from "../constants/permissions.js";
import { Branch, GoldRate, Tenant, User } from "../models/index.js";
import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { writeAudit } from "./audit.service.js";

function enforceVersion(record, expectedVersion) { if (expectedVersion && record.version !== expectedVersion) throw new AppError("VERSION_CONFLICT", "This record changed. Refresh and try again.", 409); }
export async function updateTenantSettings(req, section, patch) {
  return withTransaction(async (session) => {
    const tenant = await Tenant.findById(req.auth.tenantId).session(session); if (!tenant) throw errors.notFound("Tenant");
    enforceVersion(tenant, patch.expectedVersion); const before = tenant.toObject(); delete patch.expectedVersion;
    if (section === "profile") Object.assign(tenant, patch); else tenant.set(section, { ...tenant.get(section)?.toObject?.(), ...patch });
    tenant.version += 1; await tenant.save({ session }); const auditEventId = await writeAudit({ req, action: `TENANT_${section.toUpperCase()}_UPDATED`, entityType: AuditEntityType.TENANT, entityId: tenant._id, before, after: tenant.toObject(), session }); return { ...tenant.toObject(), auditEventId };
  });
}
export async function createBranch(req) {
  return withTransaction(async (session) => { const branch = (await Branch.create([{ _id: createId("branch"), tenantId: req.auth.tenantId, ...req.body }], { session }))[0]; const auditEventId = await writeAudit({ req, action: "BRANCH_CREATED", entityType: AuditEntityType.BRANCH, entityId: branch._id, after: branch.toObject(), session }); return { ...branch.toObject(), auditEventId }; });
}
export async function createStaff(req) {
  return withTransaction(async (session) => {
    const tenant = await Tenant.findById(req.auth.tenantId).session(session); const used = await User.countDocuments({ tenantId: tenant._id, status: UserStatus.ACTIVE }).session(session);
    const limit = tenant.subscription?.limits?.staff; if (limit && used >= limit) throw new AppError("LIMIT_STAFF", `Your plan allows ${limit} active staff.`, 403, { limit, used, currentPlan: tenant.subscription.tier });
    const temporaryPassword = req.body.temporaryPassword ?? crypto.randomUUID();
    const user = (await User.create([{ _id: createId("user"), type: UserType.TENANT_USER, tenantId: tenant._id, branchId: req.body.branchId, role: req.body.role ?? TenantRole.BRANCH_STAFF, name: req.body.name, mobile: req.body.mobile, email: req.body.email, passwordHash: await argon2.hash(temporaryPassword), mustSetPassword: true, permissions: ROLE_PERMISSIONS[req.body.role ?? TenantRole.BRANCH_STAFF] }], { session }))[0];
    const auditEventId = await writeAudit({ req, action: "STAFF_CREATED", entityType: AuditEntityType.STAFF, entityId: user._id, after: user.toObject(), session }); return { id: user._id, mustSetPassword: true, auditEventId };
  });
}
export async function setGoldRate(req) {
  return withTransaction(async (session) => {
    const rate = await GoldRate.findOneAndUpdate({ tenantId: req.auth.tenantId, branchId: req.body.branchId ?? null, effectiveDate: req.body.effectiveDate }, { $set: { ratePerGramPaise: req.body.ratePerGramPaise, purity: req.body.purity, source: req.body.source, enteredBy: req.auth.id }, $inc: { version: 1 }, $setOnInsert: { _id: createId("goldRate") } }, { upsert: true, new: true, session, setDefaultsOnInsert: true });
    const auditEventId = await writeAudit({ req, action: "GOLD_RATE_SET", entityType: AuditEntityType.GOLD_RATE, entityId: rate._id, after: rate.toObject(), session }); return { ...rate.toObject(), auditEventId };
  });
}
export async function currentGoldRate(scope, date) { return GoldRate.findOne({ tenantId: scope.tenantId, effectiveDate: date, $or: [{ branchId: scope.branchId ?? null }, { branchId: null }] }).sort({ branchId: -1, createdAt: -1 }).lean(); }
export async function latestGoldRateOnOrBefore(scope, date) { return GoldRate.findOne({ tenantId: scope.tenantId, effectiveDate: { $lte: date }, $or: [{ branchId: scope.branchId ?? null }, { branchId: null }] }).sort({ effectiveDate: -1, branchId: -1, createdAt: -1 }).lean(); }
export async function deactivateStaff(req) { return withTransaction(async (session) => { const user = await User.findOneAndUpdate({ _id: req.params.staffId, tenantId: req.auth.tenantId }, { $set: { status: UserStatus.INACTIVE }, $inc: { version: 1 } }, { new: true, session }); if (!user) throw errors.notFound("Staff"); const auditEventId = await writeAudit({ req, action: "STAFF_DEACTIVATED", entityType: AuditEntityType.STAFF, entityId: user._id, after: user.toObject(), session }); return { id: user._id, status: user.status, auditEventId }; }); }
export async function updateBranch(req) { const patch = { ...req.body }; delete patch.expectedVersion; const filter = { _id: req.params.branchId, tenantId: req.auth.tenantId, ...(req.body.expectedVersion != null ? { version: Number(req.body.expectedVersion) } : {}) }; const row = await Branch.findOneAndUpdate(filter, { $set: patch, $inc: { version: 1 } }, { new: true }); if (!row) throw new AppError("VERSION_CONFLICT", "Branch not found or changed. Refresh and try again.", 409); return row.toObject(); }
export async function setBranchActive(req, active) { const row = await Branch.findOneAndUpdate({ _id: req.params.branchId, tenantId: req.auth.tenantId }, { $set: { active }, $inc: { version: 1 } }, { new: true }); if (!row) throw errors.notFound("Branch"); return row.toObject(); }
export async function updateStaff(req) { const patch = { ...req.body }; delete patch.expectedVersion; delete patch.password; const filter = { _id: req.params.staffId, tenantId: req.auth.tenantId, ...(req.body.expectedVersion != null ? { version: Number(req.body.expectedVersion) } : {}) }; const row = await User.findOneAndUpdate(filter, { $set: patch, $inc: { version: 1 } }, { new: true }).select("-passwordHash"); if (!row) throw new AppError("VERSION_CONFLICT", "Staff record not found or changed. Refresh and try again.", 409); return row.toObject(); }
export async function activateStaff(req) { const row = await User.findOneAndUpdate({ _id: req.params.staffId, tenantId: req.auth.tenantId }, { $set: { status: UserStatus.ACTIVE }, $inc: { version: 1 } }, { new: true }).select("-passwordHash"); if (!row) throw errors.notFound("Staff"); return row.toObject(); }
export async function transferStaff(req) { const branch = await Branch.findOne({ _id: req.body.branchId, tenantId: req.auth.tenantId, active: true }).lean(); if (!branch) throw errors.notFound("Branch"); const row = await User.findOneAndUpdate({ _id: req.params.staffId, tenantId: req.auth.tenantId }, { $set: { branchId: branch._id }, $inc: { version: 1 } }, { new: true }).select("-passwordHash"); if (!row) throw errors.notFound("Staff"); return row.toObject(); }
export async function resetStaffPassword(req) { const temporaryPassword = req.body.temporaryPassword ?? crypto.randomBytes(18).toString("base64url"); const row = await User.findOneAndUpdate({ _id: req.params.staffId, tenantId: req.auth.tenantId }, { $set: { passwordHash: await argon2.hash(temporaryPassword), mustSetPassword: true }, $inc: { version: 1 } }, { new: true }).select("_id mustSetPassword"); if (!row) throw errors.notFound("Staff"); return { staffId: row._id, temporaryPassword, mustSetPassword: true }; }
