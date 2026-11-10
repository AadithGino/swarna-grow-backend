import {
  Branch,
  Customer,
  DemoCloneMap,
  DemoEvent,
  DemoInstance,
  DemoProvisionJob,
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
import { deriveTenantCodeFromName } from "../lib/platform-dto.js";
import { logger } from "../config/logger.js";
import {
  DemoEventType,
  DemoInstanceStatus,
  DemoProvisionJobKind,
  DemoProvisionJobStatus,
  DemoTemplateVersionStatus,
  TenantStatus,
} from "../constants/enums.js";
import { CLONE_FIELD_SPEC, DEMO_SLICE_COLLECTIONS, ID_KIND_BY_COLLECTION } from "../lib/demo-clone-fields.js";

/**
 * Clone/remap engine for the six DEMO_SLICE_COLLECTIONS.
 *
 * Large published snapshots (thousands of Payment/LedgerEntry rows) cannot finish inside one
 * Mongo transaction — Atlas aborts ~60s and the create API hangs in PROVISIONING. Instead we:
 * 1. Preload snapshot chunks outside any session
 * 2. Create the demo tenant
 * 3. insertMany in batches (no multi-doc transaction)
 * 4. Point the instance at the tenant only when clone succeeds
 *
 * Access stays gated by DemoInstance.status === READY + activeTenantId (see demo-session-guard).
 * On failure the partial tenant is CANCELLED so it is not usable.
 */

const MODEL_BY_NAME = { Branch, Customer, SchemePlan, Scheme, Payment, LedgerEntry };
const INSERT_BATCH_SIZE = 200;

async function loadSnapshotDocs(templateVersionId, collectionName) {
  const chunks = await DemoTemplateSnapshotChunk.find({ templateVersionId, collection: collectionName })
    .sort({ chunkIndex: 1 })
    .lean();
  return chunks.flatMap((c) => c.documents);
}

function getAtPath(obj, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function setAtPath(obj, path, value) {
  const parts = path.split(".");
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (cursor[parts[i]] == null) cursor[parts[i]] = {};
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = value;
}

async function uniqueTenantCode(businessName) {
  const base = deriveTenantCodeFromName(businessName);
  let code = base;
  let n = 0;
  // eslint-disable-next-line no-await-in-loop
  while (await Tenant.exists({ code })) {
    n += 1;
    code = `${base.slice(0, 10)}${n}`;
  }
  return code;
}

async function insertInBatches(Model, docs) {
  for (let i = 0; i < docs.length; i += INSERT_BATCH_SIZE) {
    const batch = docs.slice(i, i + INSERT_BATCH_SIZE);
    // eslint-disable-next-line no-await-in-loop
    await Model.insertMany(batch, { ordered: true });
  }
}

async function cancelPartialTenant(tenantId) {
  if (!tenantId) return;
  try {
    await Tenant.findByIdAndUpdate(tenantId, { $set: { status: TenantStatus.CANCELLED } });
  } catch (error) {
    logger.warn({ err: error, tenantId }, "failed to cancel partial demo tenant");
  }
}

/**
 * Clones one published template version into a brand-new, isolated demo tenant, and points
 * `instance` at it. `instance` must currently be PROVISIONING (fresh create) with no
 * activeTenantId yet — reset/upgrade onto an *existing* tenant is deferred, see
 * docs/demo-builder-phase-1-2-foundation.md.
 */
export async function provisionDemoInstance({ instanceId, actorId }) {
  const instance = await DemoInstance.findById(instanceId);
  if (!instance) throw errors.notFound("Demo instance");
  if (instance.status !== DemoInstanceStatus.PROVISIONING || instance.activeTenantId) {
    throw new AppError(
      "DEMO_NOT_PROVISIONABLE",
      "This demo instance is not in a provisionable state.",
      409,
    );
  }

  const templateVersion = await DemoTemplateVersion.findById(instance.templateVersionId).lean();
  if (!templateVersion || templateVersion.status !== DemoTemplateVersionStatus.PUBLISHED) {
    throw new AppError(
      "DEMO_TEMPLATE_VERSION_NOT_PUBLISHED",
      "The requested template version is not published.",
      422,
    );
  }

  const job = await DemoProvisionJob.create({
    instanceId: instance._id,
    kind: DemoProvisionJobKind.CREATE,
    targetTemplateVersionId: templateVersion._id,
    status: DemoProvisionJobStatus.RUNNING,
    phase: "LOADING_SNAPSHOT",
    startedAt: new Date(),
  });

  const generationId = createId("dgen");
  let tenantId = null;

  try {
    const snapshotByCollection = {};
    let totalDocs = 0;
    for (const collectionName of DEMO_SLICE_COLLECTIONS) {
      // eslint-disable-next-line no-await-in-loop
      const docs = await loadSnapshotDocs(templateVersion._id, collectionName);
      snapshotByCollection[collectionName] = docs;
      totalDocs += docs.length;
    }

    await DemoProvisionJob.findByIdAndUpdate(job._id, {
      $set: { phase: "CLONING", progress: 5, counters: { snapshotDocs: totalDocs } },
    });

    const businessName = `${instance.prospectName} (Demo)`.slice(0, 120);
    const tenantCode = await uniqueTenantCode(businessName);

    const tenant = await Tenant.create({
      _id: createId("tenant"),
      code: tenantCode,
      name: businessName,
      displayName: instance.branding?.displayName || instance.prospectName,
      branding: instance.branding ?? undefined,
      // Not ACTIVE until clone finishes — instance also stays PROVISIONING until then.
      status: TenantStatus.PENDING_SETUP,
      isDemo: true,
      // Unique placeholder until mobile_1 is dropped in favour of mobile_1_live_only
      // (see identity.models.js). Without this, a second demo tenant with omitted mobile
      // hits E11000 on the unconditional unique mobile index.
      mobile: `demo:${instance._id}`,
      demoInstanceId: instance._id,
      demoGenerationId: generationId,
      demoTemplateVersionId: templateVersion._id,
      prospectContactMobile: instance.prospectContactMobile ?? null,
    });
    tenantId = tenant._id;

    const idMapsByCollection = {};
    const counts = {};
    let inserted = 0;

    for (const collectionName of DEMO_SLICE_COLLECTIONS) {
      const Model = MODEL_BY_NAME[collectionName];
      const spec = CLONE_FIELD_SPEC[collectionName];
      const idKind = ID_KIND_BY_COLLECTION[collectionName];
      const sourceDocs = snapshotByCollection[collectionName];
      const idMap = new Map();
      idMapsByCollection[collectionName] = idMap;

      const toInsert = [];
      const cloneMapRows = [];
      for (const sourceDoc of sourceDocs) {
        const newId = createId(idKind);
        idMap.set(sourceDoc._id, newId);

        const transformed = { ...sourceDoc, _id: newId, tenantId: tenant._id };
        delete transformed.createdAt;
        delete transformed.updatedAt;
        delete transformed.version;

        for (const [field, targetCollection] of Object.entries(spec.idRefs ?? {})) {
          const sourceValue = transformed[field];
          if (sourceValue == null) continue;
          const targetMap = idMapsByCollection[targetCollection];
          transformed[field] = targetMap ? targetMap.get(sourceValue) ?? null : null;
        }
        for (const { path, target } of spec.arrayIdRefs ?? []) {
          const sourceArray = getAtPath(transformed, path);
          if (!Array.isArray(sourceArray)) continue;
          const targetMap = idMapsByCollection[target];
          const mapped = sourceArray
            .map((id) => (targetMap ? targetMap.get(id) : null))
            .filter((id) => id != null);
          setAtPath(transformed, path, mapped);
        }

        spec.sanitize?.(transformed, { newId, oldId: sourceDoc._id });
        toInsert.push(transformed);
        cloneMapRows.push({
          _id: createId("dmap"),
          jobId: job._id,
          instanceId: instance._id,
          generationId,
          collection: collectionName,
          sourceId: sourceDoc._id,
          destinationId: newId,
        });
      }

      if (toInsert.length) {
        // eslint-disable-next-line no-await-in-loop
        await insertInBatches(Model, toInsert);
      }
      if (cloneMapRows.length) {
        // eslint-disable-next-line no-await-in-loop
        await insertInBatches(DemoCloneMap, cloneMapRows);
      }
      counts[collectionName] = toInsert.length;
      inserted += toInsert.length;
      // eslint-disable-next-line no-await-in-loop
      await DemoProvisionJob.findByIdAndUpdate(job._id, {
        $set: {
          progress: Math.min(95, 5 + Math.round((inserted / Math.max(totalDocs, 1)) * 90)),
          counters: { ...counts, snapshotDocs: totalDocs },
        },
      });
    }

    await Tenant.findByIdAndUpdate(tenantId, { $set: { status: TenantStatus.ACTIVE } });
    await DemoProvisionJob.findByIdAndUpdate(job._id, {
      $set: {
        status: DemoProvisionJobStatus.SUCCEEDED,
        phase: "DONE",
        progress: 100,
        counters: counts,
        targetGenerationId: generationId,
        finishedAt: new Date(),
      },
    });
    await DemoInstance.findByIdAndUpdate(instance._id, {
      $set: {
        status: DemoInstanceStatus.READY,
        activeTenantId: tenantId,
        activeGenerationId: generationId,
      },
    });
    await DemoEvent.create({
      instanceId: instance._id,
      type: DemoEventType.INSTANCE_CREATED,
      actorId: actorId ?? null,
      actorType: actorId ? "PLATFORM_USER" : null,
      metadata: { generationId, tenantId, counts },
    });

    return { tenantId, generationId, counts };
  } catch (error) {
    await cancelPartialTenant(tenantId);
    await DemoProvisionJob.findByIdAndUpdate(job._id, {
      $set: {
        status: DemoProvisionJobStatus.FAILED,
        errorCode: error.code ?? "DEMO_PROVISION_FAILED",
        errorMessage: error.message,
        finishedAt: new Date(),
      },
    });
    await DemoInstance.findByIdAndUpdate(instance._id, {
      $set: { status: DemoInstanceStatus.FAILED },
    });
    await DemoEvent.create({
      instanceId: instance._id,
      type: DemoEventType.PROVISION_FAILED,
      actorId: actorId ?? null,
      actorType: actorId ? "PLATFORM_USER" : null,
      metadata: { errorCode: error.code ?? null, message: error.message },
    });
    throw error;
  }
}
