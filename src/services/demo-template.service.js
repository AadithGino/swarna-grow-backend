import {
  Branch,
  Customer,
  DemoTemplate,
  DemoTemplateSnapshotChunk,
  DemoTemplateVersion,
  LedgerEntry,
  Payment,
  Scheme,
  SchemePlan,
  Tenant,
} from "../models/index.js";
import { AppError, errors } from "../lib/app-error.js";
import { createId } from "../lib/ids.js";
import { DemoTemplateStatus, DemoTemplateVersionStatus } from "../constants/enums.js";
import { DEMO_SLICE_COLLECTIONS } from "../lib/demo-clone-fields.js";

/**
 * Template registration + publication (plan section 5.1). Scope note: see
 * src/lib/demo-clone-fields.js — this slice only snapshots Branch/Customer/SchemePlan/
 * Scheme/Payment/LedgerEntry, not every model in demo-clone-registry.js.
 */

const MODEL_BY_NAME = { Branch, Customer, SchemePlan, Scheme, Payment, LedgerEntry };
const CHUNK_SIZE = 500;
const SCHEMA_VERSION = "demo-slice-1";

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

/** Strip the handful of fields that must never sit in the snapshot at rest, even briefly. */
function stripBeforeSnapshot(collectionName, doc) {
  if (collectionName === "Customer") {
    const { passwordHash, fcmTokens, ...rest } = doc;
    return rest;
  }
  return doc;
}

export async function registerTemplate({ name, approvedSourceTenantId, actorId }) {
  const sourceTenant = await Tenant.findById(approvedSourceTenantId).select("_id code name isDemo").lean();
  if (!sourceTenant) throw errors.notFound("Source tenant");
  if (sourceTenant.isDemo) {
    throw new AppError(
      "DEMO_SOURCE_INVALID",
      "A demo tenant cannot itself be used as a Demo Builder source.",
      422,
    );
  }
  const template = await DemoTemplate.create({
    name,
    approvedSourceTenantId: sourceTenant._id,
    status: DemoTemplateStatus.DRAFT,
    createdBy: actorId,
  });
  return { template, sourceTenant: { id: sourceTenant._id, code: sourceTenant.code, name: sourceTenant.name } };
}

export async function listTemplates() {
  const templates = await DemoTemplate.find().sort({ createdAt: -1 }).lean();
  return templates;
}

export async function getTemplate(templateId) {
  const template = await DemoTemplate.findById(templateId).lean();
  if (!template) throw errors.notFound("Demo template");
  return template;
}

export async function listTemplateVersions(templateId) {
  return DemoTemplateVersion.find({ templateId })
    .select("-snapshotArtifactRef")
    .sort({ version: -1 })
    .lean();
}

/**
 * Publication (plan 5.1 steps 1-6, scoped per demo-clone-fields.js). Synchronous — there is
 * no background job/queue in this slice; see docs/demo-builder-phase-1-2-foundation.md. Fine
 * for a curated "sample tenant" of a few hundred records; would need to move to a real job
 * before pointing this at a large live tenant.
 */
export async function publishTemplateVersion({ templateId, actorId }) {
  const template = await DemoTemplate.findById(templateId);
  if (!template) throw errors.notFound("Demo template");

  const previousVersion = await DemoTemplateVersion.findOne({ templateId }).sort({ version: -1 }).lean();
  const nextVersionNumber = (previousVersion?.version ?? 0) + 1;

  let version = await DemoTemplateVersion.create({
    templateId,
    version: nextVersionNumber,
    schemaVersion: SCHEMA_VERSION,
    status: DemoTemplateVersionStatus.SNAPSHOTTING,
    dateAnchor: new Date(),
  });

  try {
    const counts = {};
    // Pass 1: snapshot every collection as-is (source ids preserved) so pass 2 can validate
    // cross-collection references before anything is marked PUBLISHED.
    const snapshotsByCollection = {};
    for (const collectionName of DEMO_SLICE_COLLECTIONS) {
      const Model = MODEL_BY_NAME[collectionName];
      const docs = await Model.find({ tenantId: template.approvedSourceTenantId }).lean();
      const cleaned = docs.map((doc) => stripBeforeSnapshot(collectionName, doc));
      snapshotsByCollection[collectionName] = cleaned;
      counts[collectionName] = cleaned.length;
      const chunks = chunk(cleaned, CHUNK_SIZE);
      if (chunks.length === 0) continue;
      await DemoTemplateSnapshotChunk.insertMany(
        chunks.map((documents, chunkIndex) => ({
          templateVersionId: version._id,
          collection: collectionName,
          chunkIndex,
          documents,
        })),
      );
    }

    const findings = validateSnapshotReferences(snapshotsByCollection);
    if (findings.length) {
      version = await DemoTemplateVersion.findByIdAndUpdate(
        version._id,
        {
          $set: {
            status: DemoTemplateVersionStatus.FAILED,
            failureReason: findings.join("; "),
            manifest: { counts, findings },
          },
        },
        { new: true },
      );
      throw new AppError(
        "DEMO_TEMPLATE_VALIDATION_FAILED",
        `Template snapshot failed validation: ${findings.join("; ")}`,
        422,
      );
    }

    if ((counts.Customer ?? 0) === 0) {
      throw new AppError(
        "DEMO_TEMPLATE_NO_CUSTOMERS",
        "The source tenant has no customers to snapshot — nothing to demo.",
        422,
      );
    }

    version = await DemoTemplateVersion.findByIdAndUpdate(
      version._id,
      {
        $set: {
          status: DemoTemplateVersionStatus.PUBLISHED,
          manifest: { counts },
          publishedBy: actorId,
          publishedAt: new Date(),
        },
      },
      { new: true },
    );
    template.currentPublishedVersionId = version._id;
    template.status = DemoTemplateStatus.ACTIVE;
    await template.save();
    return version;
  } catch (error) {
    if (version.status === DemoTemplateVersionStatus.SNAPSHOTTING) {
      await DemoTemplateVersion.findByIdAndUpdate(version._id, {
        $set: { status: DemoTemplateVersionStatus.FAILED, failureReason: error.message },
      });
    }
    throw error;
  }
}

/**
 * Plan 5.1 step 5, scoped to this slice's six collections: every foreign key must resolve
 * inside the same snapshot. Cheap but real — catches a half-migrated or inconsistent source
 * tenant before it is ever published, let alone cloned.
 */
function validateSnapshotReferences(snapshotsByCollection) {
  const idsOf = (collectionName) => new Set((snapshotsByCollection[collectionName] ?? []).map((doc) => doc._id));
  const branchIds = idsOf("Branch");
  const customerIds = idsOf("Customer");
  const planIds = idsOf("SchemePlan");
  const schemeIds = idsOf("Scheme");
  const findings = [];
  for (const scheme of snapshotsByCollection.Scheme ?? []) {
    if (scheme.branchId && !branchIds.has(scheme.branchId)) {
      findings.push(`Scheme ${scheme._id} references missing Branch ${scheme.branchId}`);
    }
    if (!customerIds.has(scheme.customerId)) {
      findings.push(`Scheme ${scheme._id} references missing Customer ${scheme.customerId}`);
    }
    if (!planIds.has(scheme.planId)) {
      findings.push(`Scheme ${scheme._id} references missing SchemePlan ${scheme.planId}`);
    }
  }
  for (const payment of snapshotsByCollection.Payment ?? []) {
    if (!schemeIds.has(payment.schemeId)) {
      findings.push(`Payment ${payment._id} references missing Scheme ${payment.schemeId}`);
    }
    if (!customerIds.has(payment.customerId)) {
      findings.push(`Payment ${payment._id} references missing Customer ${payment.customerId}`);
    }
  }
  for (const entry of snapshotsByCollection.LedgerEntry ?? []) {
    if (!schemeIds.has(entry.schemeId)) {
      findings.push(`LedgerEntry ${entry._id} references missing Scheme ${entry.schemeId}`);
    }
    if (!customerIds.has(entry.customerId)) {
      findings.push(`LedgerEntry ${entry._id} references missing Customer ${entry.customerId}`);
    }
  }
  for (const customer of snapshotsByCollection.Customer ?? []) {
    if (customer.branchId && !branchIds.has(customer.branchId)) {
      findings.push(`Customer ${customer._id} references missing Branch ${customer.branchId}`);
    }
  }
  return findings.slice(0, 50); // cap — this is a validation report, not a full audit dump
}
