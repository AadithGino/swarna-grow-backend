import test from "node:test";
import assert from "node:assert/strict";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { env } from "../src/config/env.js";
import { Permission } from "../src/constants/permissions.js";
import { EcommercePromotionCampaign, Branch, GoldRate } from "../src/models/index.js";
import { MessageType, TenantRole } from "../src/constants/enums.js";
import { buildPushPayload } from "../src/lib/push-payload.js";
import { createId } from "../src/lib/ids.js";
import { resolveAuthorizedSchemeGoldRateBranchId } from "../src/lib/gold-rate-branch-auth.js";
import { ensureRunnableMaintenanceJob } from "../src/lib/maintenance-queue-job.js";
import { tryEnqueuePromotionAfterCommit } from "../src/services/ecommerce-promotion.service.js";
import { setCalendarDateOverrideForTests, resetCalendarDateOverrideForTests } from "../src/lib/date.js";
import { bearerFor, resetTestDb, seedBranch, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import request from "supertest";
import { createApp } from "../src/app.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  resetCalendarDateOverrideForTests();
});

test("branch-scoped user cannot publish tenant-wide gold rate", async () => {
  const { tenant, branch } = await seedTenantUser({});
  await assert.rejects(
    () => resolveAuthorizedSchemeGoldRateBranchId(
      { auth: { tenantId: tenant._id }, scope: { tenantId: tenant._id, branchId: branch._id } },
      null,
    ),
    (err) => err.statusCode === 403,
  );
  const other = await Branch.create({
    _id: createId("br"),
    tenantId: tenant._id,
    name: "Other",
    code: "OTH",
    active: true,
  });
  await assert.rejects(
    () => resolveAuthorizedSchemeGoldRateBranchId(
      { auth: { tenantId: tenant._id }, scope: { tenantId: tenant._id, branchId: branch._id } },
      other._id,
    ),
    (err) => err.statusCode === 403,
  );
  const ok = await resolveAuthorizedSchemeGoldRateBranchId(
    { auth: { tenantId: tenant._id }, scope: { tenantId: tenant._id, branchId: branch._id } },
    branch._id,
  );
  assert.equal(ok, branch._id);
});

test("branch manager HTTP — own branch ok, tenant-wide and other branch rejected", async () => {
  setCalendarDateOverrideForTests("2026-06-15");
  const { tenant, user, branch } = await seedTenantUser({ role: TenantRole.BRANCH_MANAGER });
  const other = await seedBranch({ tenantId: tenant._id, code: "BR2" });
  const perms = [Permission.GOLD_RATE_WRITE, Permission.MESSAGE_SEND];
  const wide = await request(app)
    .post("/api/v1/admin/gold-rate")
    .set({
      authorization: `Bearer ${bearerFor(user, perms)}`,
      "x-idempotency-key": "idem-br-wide",
    })
    .send({
      ratePerGramPaise: 700_000,
      effectiveDate: "2026-06-15",
      notification: { enabled: true },
    });
  assert.equal(wide.status, 403);
  assert.equal(await GoldRate.countDocuments({ tenantId: tenant._id }), 0);
  assert.equal(await EcommercePromotionCampaign.countDocuments({ tenantId: tenant._id }), 0);

  const cross = await request(app)
    .post("/api/v1/admin/gold-rate")
    .set({
      authorization: `Bearer ${bearerFor(user, perms)}`,
      "x-idempotency-key": "idem-br-cross",
    })
    .send({
      ratePerGramPaise: 700_000,
      effectiveDate: "2026-06-15",
      branchId: other._id,
      notification: { enabled: true },
    });
  assert.equal(cross.status, 403);
  assert.equal(await GoldRate.countDocuments({ tenantId: tenant._id }), 0);

  const ok = await request(app)
    .post("/api/v1/admin/gold-rate")
    .set({
      authorization: `Bearer ${bearerFor(user, perms)}`,
      "x-idempotency-key": "idem-br-ok",
    })
    .send({
      ratePerGramPaise: 701_000,
      effectiveDate: "2026-06-15",
      branchId: branch._id,
      notification: { enabled: true },
    });
  assert.equal(ok.status, 201);
  assert.equal(await GoldRate.countDocuments({ tenantId: tenant._id, branchId: branch._id }), 1);
});

test("post-commit enqueue survives lookup failure with intentPersisted true", async () => {
  const { tenant } = await seedTenantUser({});
  const campaignId = createId("epcm");
  await EcommercePromotionCampaign.create({
    _id: campaignId,
    tenantId: tenant._id,
    businessKey: "scheme-gold-rate:grt_x",
    kind: "SCHEME_GOLD_RATE",
    status: "QUEUED",
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    requestedBy: createId("usr"),
    rateId: createId("grt"),
    rateSource: "SCHEME",
    schemeEffectiveDate: "2026-06-15",
  });
  const original = EcommercePromotionCampaign.findOne.bind(EcommercePromotionCampaign);
  EcommercePromotionCampaign.findOne = () => {
    throw new Error("DISPATCH_TEST_DB_READ");
  };
  try {
    const result = await tryEnqueuePromotionAfterCommit(campaignId, tenant._id);
    assert.equal(result.intentPersisted, true);
    assert.equal(result.enqueued, false);
    assert.match(String(result.enqueueError), /DISPATCH_TEST_DB_READ/);
  } finally {
    EcommercePromotionCampaign.findOne = original;
  }
});

test("ensureRunnableMaintenanceJob reuses waiting job and replaces completed job", async () => {
  const probe = new IORedis(env.REDIS_URL, { connectTimeout: 1500, maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await probe.connect();
    await probe.ping();
  } catch (error) {
    assert.fail(`Redis required: ${error.message}`);
  } finally {
    await probe.quit();
  }

  const queueName = `test-maint-${createId("q")}`;
  const queue = new Queue(queueName, { connection: { url: env.REDIS_URL } });
  try {
    const jobId = `job-${createId("j")}`;
    const first = await ensureRunnableMaintenanceJob(queue, "noop", { x: 1 }, jobId, {});
    assert.equal(first.scheduled, true);
    const second = await ensureRunnableMaintenanceJob(queue, "noop", { x: 1 }, jobId, {});
    assert.equal(second.alreadyPending, true);
    const job = await queue.getJob(jobId);
    await job.remove();
    const third = await ensureRunnableMaintenanceJob(queue, "noop", { x: 2 }, jobId, {});
    assert.equal(third.scheduled, true);
  } finally {
    await queue.obliterate({ force: true });
    await queue.close();
  }
});

async function enableEcommerce(tenantRow) {
  const { Tenant } = await import("../src/models/index.js");
  const { PlanTier } = await import("../src/constants/enums.js");
  await Tenant.updateOne(
    { _id: tenantRow._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot": { ecommerce: true },
        "subscription.tier": PlanTier.PRO,
        "operations.ecommerceEnabled": true,
      },
    },
  );
}

test("ecommerce publish with effectiveTiming NOW accepts notification", async () => {
  setCalendarDateOverrideForTests("2026-06-15");
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const perms = [Permission.ECOMMERCE_WRITE, Permission.MESSAGE_SEND];
  const res = await request(app)
    .post("/api/v1/admin/ecommerce/gold-rates")
    .set({
      authorization: `Bearer ${bearerFor(user, perms)}`,
      "x-idempotency-key": "idem-eco-now",
    })
    .send({
      purity: "22K",
      ratePerGramPaise: 650_000,
      effectiveTiming: "NOW",
      notification: { enabled: true },
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.notification?.intentPersisted, true);
});

test("stale scheme business date fails revalidation", async () => {
  setCalendarDateOverrideForTests("2026-06-16");
  const { revalidateSchemeGoldRateNotification } = await import("../src/lib/gold-rate-notification-validate.js");
  const result = await revalidateSchemeGoldRateNotification(
    { rateId: "grt_1", tenantId: "tnt_1", schemeEffectiveDate: "2026-06-15" },
    {},
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "STALE_BUSINESS_DATE");
});

test("buildPushPayload forwards gold rate metadata in FCM data", () => {
  const payload = buildPushPayload({
    message: {
      _id: "msg_rate",
      type: MessageType.SCHEME_GOLD_RATE_UPDATED,
      templateParams: {
        rateId: "grt_abc",
        rateSource: "SCHEME",
        purity: "22K",
        ratePerGramPaise: 725000,
        schemeEffectiveDate: "2026-06-15",
        branchId: "br_hq",
        campaignBusinessKey: "scheme-gold-rate:grt_abc",
        deepLink: "/gold-rates",
      },
    },
    tenant: { name: "Demo Jewellers" },
  });
  assert.equal(payload.data.rateId, "grt_abc");
  assert.equal(payload.data.rateSource, "SCHEME");
  assert.equal(payload.data.purity, "22K");
  assert.equal(payload.data.ratePerGramPaise, "725000");
  assert.equal(payload.data.schemeEffectiveDate, "2026-06-15");
  assert.equal(payload.data.branchId, "br_hq");
  assert.equal(payload.data.campaignBusinessKey, "scheme-gold-rate:grt_abc");
  assert.equal(payload.data.deepLink, "/gold-rates");
});
