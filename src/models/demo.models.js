import mongoose from "mongoose";
import {
  DemoClonePolicy,
  DemoEventType,
  DemoInstanceStatus,
  DemoProvisionJobKind,
  DemoProvisionJobStatus,
  DemoTemplateStatus,
  DemoTemplateVersionStatus,
} from "../constants/enums.js";
import {
  baseOptions,
  enumField,
  immutablePlugin,
  integerField,
  stringId,
  versionField,
} from "./schema-helpers.js";

/**
 * Demo Builder models — see docs/demo-builder-phase-1-2-foundation.md for what is and
 * isn't wired up yet. These models exist so later phases (snapshot publication,
 * provisioning, Platform Manager UI) have a stable shape to build against; no service,
 * controller or route in this codebase writes to them yet.
 */

// ---------------------------------------------------------------------------
// DemoTemplate — the registered master (e.g. the approved KAIRALI DEMO tenant).
// ---------------------------------------------------------------------------
const demoTemplateSchema = new mongoose.Schema(
  {
    _id: stringId("dtpl"),
    name: { type: String, required: true, trim: true },
    /** The approved live tenant this template is snapshotted from. Set once by an operator who has confirmed its identity — never inferred from a tenant's display name. */
    approvedSourceTenantId: { type: String, required: true, index: true },
    currentPublishedVersionId: { type: String, default: null },
    status: enumField(DemoTemplateStatus, { default: DemoTemplateStatus.DRAFT }),
    createdBy: { type: String, required: true },
    version: versionField,
  },
  baseOptions,
);
demoTemplateSchema.index({ approvedSourceTenantId: 1 });

// ---------------------------------------------------------------------------
// DemoTemplateVersion — immutable once PUBLISHED. The private snapshot artifact
// itself lives in object storage; this record is the manifest/pointer to it.
// ---------------------------------------------------------------------------
const demoTemplateVersionSchema = new mongoose.Schema(
  {
    _id: stringId("dtplv"),
    templateId: { type: String, required: true, index: true },
    version: { type: Number, required: true },
    schemaVersion: { type: String, required: true },
    status: enumField(DemoTemplateVersionStatus, {
      default: DemoTemplateVersionStatus.SNAPSHOTTING,
    }),
    /** Pointer to the private snapshot artifact (never a public URL). */
    snapshotArtifactRef: { type: String, default: null },
    checksum: { type: String, default: null },
    /** Collection-by-collection counts, scenario/customer choices, module coverage, validation findings. */
    manifest: { type: mongoose.Schema.Types.Mixed, default: null },
    /** Reference date the template's data is anchored to, for coherent date translation on clone (plan 5.3 step 5). */
    dateAnchor: { type: Date, default: null },
    publishedBy: { type: String, default: null },
    publishedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
  },
  baseOptions,
);
demoTemplateVersionSchema.index({ templateId: 1, version: 1 }, { unique: true });
demoTemplateVersionSchema.index({ templateId: 1, status: 1 });
// Not schema-level immutable: publication is progressive (SNAPSHOTTING -> VALIDATING ->
// PUBLISHED/FAILED), writing manifest/checksum/snapshotArtifactRef as it goes. "Immutable
// once published" (plan section 4.2) must be enforced in demo-template.service.js by
// refusing any further write once status === PUBLISHED, the same way the rest of this
// codebase's schema.plugin(immutablePlugin) records (ledger entries, rate versions,
// audit events) are instead created fully-formed in a single insert.

// ---------------------------------------------------------------------------
// DemoInstance — one prospect's demo workspace (publicId is what the share link uses).
// ---------------------------------------------------------------------------
const demoBrandingSchema = new mongoose.Schema(
  {
    logoUploadId: String,
    primaryColor: String,
    accentColor: String,
    displayName: String,
    splashBackgroundColor: String,
    splashTagline: String,
    splashEnabled: { type: Boolean, default: true },
    /** Bumped whenever branding changes, so clients can invalidate cached branding/CSS vars. */
    revision: integerField({ min: 0, default: 1 }),
  },
  { _id: false },
);

const demoInstanceSchema = new mongoose.Schema(
  {
    _id: stringId("dins"),
    /** Opaque, URL-safe id used in the public share link. Never the Mongo _id. */
    publicId: { type: String, required: true, unique: true },
    prospectName: { type: String, required: true, trim: true },
    prospectContactMobile: { type: String, default: null },
    branding: { type: demoBrandingSchema, default: () => ({}) },
    templateVersionId: { type: String, required: true },
    /** The live tenant/generation currently served for this instance; null while PROVISIONING. */
    activeTenantId: { type: String, default: null },
    activeGenerationId: { type: String, default: null },
    status: enumField(DemoInstanceStatus, { default: DemoInstanceStatus.PROVISIONING }),
    expiresAt: { type: Date, required: true },
    createdBy: { type: String, required: true },
    /** Bumped on link rotation; outstanding sessions signed with an older value are rejected. */
    linkVersion: integerField({ min: 1, default: 1 }),
    linkSecretHash: { type: String, required: true, select: false },
    /** Only populated when recoverable "copy link" was requested; see plan 6.2. */
    sealedLinkSecret: { type: String, default: null, select: false },
    disabledAt: { type: Date, default: null },
    lastOpenedAt: { type: Date, default: null },
    version: versionField,
  },
  baseOptions,
);
demoInstanceSchema.index({ publicId: 1 }, { unique: true });
demoInstanceSchema.index({ linkSecretHash: 1 }, { unique: true });
demoInstanceSchema.index({ status: 1, expiresAt: 1 });
demoInstanceSchema.index({ createdBy: 1, createdAt: -1 });
// Deliberately no TTL index here — see plan section 4.2: expiry must block access
// immediately via status/expiresAt checks, while cleanup of dependent data happens
// through DemoCleanup, in a controlled order, not a blind Mongo auto-delete.

// ---------------------------------------------------------------------------
// DemoProvisionJob — durable job record for CREATE/RESET/UPGRADE/PURGE.
// ---------------------------------------------------------------------------
const demoProvisionJobSchema = new mongoose.Schema(
  {
    _id: stringId("djob"),
    instanceId: { type: String, required: true, index: true },
    kind: enumField(DemoProvisionJobKind, { required: true }),
    targetTemplateVersionId: { type: String, default: null },
    targetGenerationId: { type: String, default: null },
    status: enumField(DemoProvisionJobStatus, { default: DemoProvisionJobStatus.QUEUED }),
    /** Human-facing phase label shown in the Platform Manager progress screen (plan 8.3). */
    phase: { type: String, default: null },
    counters: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    progress: { type: Number, min: 0, max: 100, default: 0 },
    /** Lease owner + heartbeat, so a scheduled sweep can find an abandoned job (plan 5.3 step 9). */
    leaseOwner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    heartbeatAt: { type: Date, default: null },
    attempts: integerField({ min: 0, default: 0 }),
    /** Caller-supplied Idempotency-Key, scoped to instanceId+kind. */
    idempotencyKey: { type: String, default: null },
    /** Safe-for-UI error summary only; never a raw stack trace or secret. */
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },
    verification: { type: mongoose.Schema.Types.Mixed, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    version: versionField,
  },
  baseOptions,
);
demoProvisionJobSchema.index({ instanceId: 1, status: 1 });
demoProvisionJobSchema.index(
  { instanceId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
);
demoProvisionJobSchema.index({ status: 1, leaseExpiresAt: 1 });

// ---------------------------------------------------------------------------
// DemoCloneMap — durable sourceId -> destinationId remapping, doubles as a
// resume checkpoint and as the ownership record purge uses (plan 5.3 step 3, 11).
// ---------------------------------------------------------------------------
const demoCloneMapSchema = new mongoose.Schema(
  {
    _id: stringId("dmap"),
    jobId: { type: String, required: true, index: true },
    instanceId: { type: String, required: true, index: true },
    generationId: { type: String, required: true },
    /** Mongoose model name of the source collection, e.g. "Customer", "SchemePlan". */
    collection: { type: String, required: true },
    sourceId: { type: String, required: true },
    destinationId: { type: String, required: true },
  },
  baseOptions,
);
demoCloneMapSchema.index({ jobId: 1, collection: 1, sourceId: 1 }, { unique: true });
demoCloneMapSchema.index({ generationId: 1, collection: 1 });
// Retention-only cleanup (plan 4.2); not a correctness-critical TTL, so left to DemoCleanup
// rather than an automatic Mongo TTL index, same reasoning as DemoInstance above.

// ---------------------------------------------------------------------------
// DemoEvent — append-only audit trail. Never holds secrets or personal payloads.
// ---------------------------------------------------------------------------
const demoEventSchema = new mongoose.Schema(
  {
    _id: stringId("devt"),
    instanceId: { type: String, required: true, index: true },
    type: enumField(DemoEventType, { required: true }),
    actorId: { type: String, default: null },
    actorType: { type: String, default: null },
    sessionId: { type: String, default: null },
    /** Safe metadata only — e.g. { fromVersion, toVersion } on an upgrade, never a link secret or customer PII. */
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  baseOptions,
);
demoEventSchema.index({ instanceId: 1, createdAt: -1 });
demoEventSchema.plugin(immutablePlugin);

// ---------------------------------------------------------------------------
// DemoTemplateSnapshotChunk — the actual snapshotted documents for one source
// collection, chunked to stay well under MongoDB's 16MB document limit. This is a
// deliberately simple stand-in for the "private snapshot artifact" the plan describes in
// section 5.1 as living in object storage — see docs/demo-builder-phase-1-2-foundation.md
// for why, and what moving it to real object storage later would involve.
// ---------------------------------------------------------------------------
const demoTemplateSnapshotChunkSchema = new mongoose.Schema(
  {
    _id: stringId("dchk"),
    templateVersionId: { type: String, required: true, index: true },
    /** Mongoose model name of the source collection, e.g. "Customer". */
    collection: { type: String, required: true },
    chunkIndex: integerField({ min: 0, default: 0 }),
    /** Plain sanitized documents, each still carrying its original source `_id`. */
    documents: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  baseOptions,
);
demoTemplateSnapshotChunkSchema.index(
  { templateVersionId: 1, collection: 1, chunkIndex: 1 },
  { unique: true },
);

export const DemoTemplate = mongoose.model("DemoTemplate", demoTemplateSchema);
export const DemoTemplateVersion = mongoose.model("DemoTemplateVersion", demoTemplateVersionSchema);
export const DemoInstance = mongoose.model("DemoInstance", demoInstanceSchema);
export const DemoProvisionJob = mongoose.model("DemoProvisionJob", demoProvisionJobSchema);
export const DemoCloneMap = mongoose.model("DemoCloneMap", demoCloneMapSchema);
export const DemoTemplateSnapshotChunk = mongoose.model(
  "DemoTemplateSnapshotChunk",
  demoTemplateSnapshotChunkSchema,
);
export const DemoEvent = mongoose.model("DemoEvent", demoEventSchema);
