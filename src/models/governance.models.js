import mongoose from "mongoose";
import { AuditActorType, AuditEntityType, GrievanceCategory, GrievanceMessageType, GrievancePriority, GrievanceRelatedEntityType, GrievanceStatus, IdempotencyState, JobStatus, WebhookProvider } from "../constants/enums.js";
import { baseOptions, branchField, enumField, immutablePlugin, stringId, tenantField, versionField } from "./schema-helpers.js";

const auditEventSchema = new mongoose.Schema({
  _id: stringId("aud"), tenantId: tenantField, branchId: branchField, actorType: enumField(AuditActorType, { required: true }), actorId: String, action: { type: String, required: true, index: true }, entityType: enumField(AuditEntityType, { required: true }), entityId: { type: String, required: true, index: true },
  before: mongoose.Schema.Types.Mixed, after: mongoose.Schema.Types.Mixed, metadata: mongoose.Schema.Types.Mixed, traceId: String, ip: String, userAgent: String, occurredAt: { type: Date, default: Date.now, index: true },
}, { ...baseOptions, timestamps: false });
auditEventSchema.index({ tenantId: 1, entityType: 1, entityId: 1, occurredAt: -1 }); auditEventSchema.plugin(immutablePlugin);

const grievanceMessageSchema = new mongoose.Schema({ _id: stringId("gvm"), type: enumField(GrievanceMessageType, { required: true }), actorType: enumField(AuditActorType, { required: true }), actorId: String, body: String, attachmentUploadIds: [String], createdAt: { type: Date, default: Date.now } }, { _id: false });
const grievanceSchema = new mongoose.Schema({
  _id: stringId("grv"), tenantId: tenantField, branchId: branchField, customerId: { type: String, required: true, index: true }, ticketNumber: { type: String, required: true }, category: enumField(GrievanceCategory, { required: true }), priority: enumField(GrievancePriority, { default: GrievancePriority.NORMAL }), status: enumField(GrievanceStatus, { default: GrievanceStatus.OPEN }),
  subject: { type: String, required: true }, description: { type: String, required: true }, relatedEntity: { type: enumField(GrievanceRelatedEntityType), id: String }, attachmentUploadIds: [String], assigneeId: String,
  firstResponseDueAt: { type: Date, required: true }, firstResponseAt: Date, resolvedAt: Date, closedAt: Date, messages: { type: [grievanceMessageSchema], default: [] }, version: versionField,
}, baseOptions);
grievanceSchema.index({ tenantId: 1, ticketNumber: 1 }, { unique: true }); grievanceSchema.index({ tenantId: 1, branchId: 1, status: 1, priority: 1, createdAt: -1 });

const webhookEventSchema = new mongoose.Schema({ _id: stringId("whk"), tenantId: tenantField, provider: enumField(WebhookProvider, { required: true }), providerEventId: { type: String, required: true }, signature: String, rawBody: Buffer, payload: mongoose.Schema.Types.Mixed, status: enumField(JobStatus, { default: JobStatus.QUEUED }), attempts: Number, error: String, processedAt: Date }, baseOptions);
webhookEventSchema.index({ provider: 1, providerEventId: 1 }, { unique: true });
const outboxEventSchema = new mongoose.Schema({ tenantId: tenantField, topic: { type: String, required: true }, key: String, payload: mongoose.Schema.Types.Mixed, status: enumField(JobStatus, { default: JobStatus.QUEUED }), availableAt: { type: Date, default: Date.now }, attempts: { type: Number, default: 0 }, lockedAt: Date, processedAt: Date, error: String }, baseOptions);
outboxEventSchema.index({ status: 1, availableAt: 1 });
const idempotencySchema = new mongoose.Schema({ tenantId: { type: String, index: true }, actorId: String, endpoint: String, key: String, bodyHash: String, state: enumField(IdempotencyState, { default: IdempotencyState.PROCESSING }), responseStatus: Number, responseBody: mongoose.Schema.Types.Mixed, expiresAt: Date, leaseOwner: String, leaseExpiresAt: Date, heartbeatAt: Date }, baseOptions);
idempotencySchema.index({ tenantId: 1, actorId: 1, endpoint: 1, key: 1 }, { unique: true }); idempotencySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const errorLogSchema = new mongoose.Schema({ _id: stringId("err"), tenantId: { type: String, default: null, index: true }, actorId: String, method: String, path: String, code: String, message: String, statusCode: Number, traceId: String, stack: String, occurredAt: { type: Date, default: Date.now, index: true } }, { ...baseOptions, timestamps: false });
errorLogSchema.index({ occurredAt: -1 });

export const AuditEvent = mongoose.model("AuditEvent", auditEventSchema);
export const Grievance = mongoose.model("Grievance", grievanceSchema);
export const WebhookEvent = mongoose.model("WebhookEvent", webhookEventSchema);
export const OutboxEvent = mongoose.model("OutboxEvent", outboxEventSchema);
export const IdempotencyRecord = mongoose.model("IdempotencyRecord", idempotencySchema);
export const ErrorLog = mongoose.model("ErrorLog", errorLogSchema);
