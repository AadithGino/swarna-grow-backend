import test from "node:test";
import assert from "node:assert/strict";
import {
  EcommercePromotionCampaignStatus,
  EcommercePromotionKind,
  JobStatus,
  MessageChannel,
  MessageStatus,
  MessageType,
  PushBroadcastSourceKind,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { fanoutDueJobId, resolveFanoutNotDueResumeAt } from "../src/lib/fanout-not-due-schedule.js";
import { buildActiveFanoutRecoveryFilter, isFutureFanoutDeferral } from "../src/lib/fanout-recovery.js";
import { setCalendarDateOverrideForTests, resetCalendarDateOverrideForTests } from "../src/lib/date.js";
import {
  EcommercePromotionCampaign,
  Message,
  PushBroadcast,
} from "../src/models/index.js";
import {
  listCampaignsForDispatchReconciliation,
  recoverIncompletePromotionBroadcastStops,
  reconcilePromotionCampaignDispatch,
  runEcommercePromotionMaintenance,
  stopPromotionBroadcastFanout,
} from "../src/services/ecommerce-promotion-delivery.service.js";
import {
  processPushBroadcastFanout,
  recoverActivePushBroadcastFanouts,
  scheduleFanoutContinuationAt,
} from "../src/services/push-broadcast.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  resetCalendarDateOverrideForTests();
});

test("stale worker stop does not cancel campaign or complete broadcast", async () => {
  const { tenant, user } = await seedTenantUser({});
  const broadcastId = createId("pb");
  const campaignId = createId("epcm");
  const businessKey = `stale:stop:${Date.now()}`;
  await PushBroadcast.create({
    _id: broadcastId,
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    messageType: MessageType.ECOMMERCE_PRODUCT_PROMOTION,
    sourceKind: PushBroadcastSourceKind.ECOMMERCE_PROMOTION,
    campaignBusinessKey: businessKey,
    status: JobStatus.PROCESSING,
    leaseOwner: "owner-b",
  });
  await EcommercePromotionCampaign.create({
    _id: campaignId,
    tenantId: tenant._id,
    businessKey,
    kind: EcommercePromotionKind.MANUAL_PRODUCT,
    status: EcommercePromotionCampaignStatus.SENDING,
    broadcastId,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    requestedBy: user._id,
  });

  const result = await stopPromotionBroadcastFanout({
    broadcastId,
    tenantId: tenant._id,
    leaseToken: "owner-a",
    reason: "PRODUCT_NOT_PUBLISHED",
  });
  assert.equal(result.stopped, false);
  assert.equal(result.stale, true);

  const broadcast = await PushBroadcast.findById(broadcastId).lean();
  assert.equal(broadcast.status, JobStatus.PROCESSING);
  assert.equal(broadcast.leaseOwner, "owner-b");
  const campaign = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(campaign.status, EcommercePromotionCampaignStatus.SENDING);
});

test("current lease owner stops broadcast and clears lease; repeat stop is idempotent", async () => {
  const { tenant, user } = await seedTenantUser({});
  const broadcastId = createId("pb");
  const campaignId = createId("epcm");
  const businessKey = `good:stop:${Date.now()}`;
  await PushBroadcast.create({
    _id: broadcastId,
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    messageType: MessageType.ECOMMERCE_PRODUCT_PROMOTION,
    sourceKind: PushBroadcastSourceKind.ECOMMERCE_PROMOTION,
    campaignBusinessKey: businessKey,
    status: JobStatus.PROCESSING,
    leaseOwner: "owner-a",
  });
  await EcommercePromotionCampaign.create({
    _id: campaignId,
    tenantId: tenant._id,
    businessKey,
    kind: EcommercePromotionKind.MANUAL_PRODUCT,
    status: EcommercePromotionCampaignStatus.SENDING,
    broadcastId,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    requestedBy: user._id,
  });

  const first = await stopPromotionBroadcastFanout({
    broadcastId,
    tenantId: tenant._id,
    leaseToken: "owner-a",
    reason: "PRODUCT_NOT_PUBLISHED",
  });
  assert.equal(first.stopped, true);
  const broadcast = await PushBroadcast.findById(broadcastId).lean();
  assert.equal(broadcast.status, JobStatus.COMPLETED);
  assert.equal(broadcast.fanoutStopReason, "PRODUCT_NOT_PUBLISHED");
  assert.equal(broadcast.leaseOwner, null);

  const second = await stopPromotionBroadcastFanout({
    broadcastId,
    tenantId: tenant._id,
    leaseToken: "owner-a",
    reason: "PRODUCT_NOT_PUBLISHED",
  });
  assert.equal(second.stopped, true);
  assert.equal(second.idempotent, true);
});

test("recoverIncompletePromotionBroadcastStops finishes campaign after broadcast-only stop", async () => {
  const { tenant, user } = await seedTenantUser({});
  const broadcastId = createId("pb");
  const campaignId = createId("epcm");
  const businessKey = `recover:stop:${Date.now()}`;
  await PushBroadcast.create({
    _id: broadcastId,
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    messageType: MessageType.ECOMMERCE_PRODUCT_PROMOTION,
    sourceKind: PushBroadcastSourceKind.ECOMMERCE_PROMOTION,
    campaignBusinessKey: businessKey,
    status: JobStatus.COMPLETED,
    completedAt: new Date(),
    error: "CATEGORY_INACTIVE",
    fanoutStopReason: "CATEGORY_INACTIVE",
  });
  await EcommercePromotionCampaign.create({
    _id: campaignId,
    tenantId: tenant._id,
    businessKey,
    kind: EcommercePromotionKind.MANUAL_PRODUCT,
    status: EcommercePromotionCampaignStatus.SENDING,
    broadcastId,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    requestedBy: user._id,
  });

  const { recovered } = await recoverIncompletePromotionBroadcastStops(10);
  assert.equal(recovered, 1);
  const campaign = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(campaign.status, EcommercePromotionCampaignStatus.CANCELLED);
  assert.equal(campaign.skippedReason, "CATEGORY_INACTIVE");
  const broadcast = await PushBroadcast.findById(broadcastId).lean();
  assert.ok(broadcast.fanoutStopRecoveryCompletedAt);
});

test("stop recovery scan skips backfilled rows so newer interrupted stops are reached", async () => {
  const { tenant, user } = await seedTenantUser({});
  const completedAt = new Date("2020-01-01T00:00:00.000Z");
  const backfillDocs = [];
  for (let i = 0; i < 55; i += 1) {
    backfillDocs.push({
      _id: createId(`pb-old-${i}`),
      tenantId: tenant._id,
      requestedBy: user._id,
      title: "Old",
      body: "B",
      audience: "ALL_DEVICES",
      messageType: MessageType.ECOMMERCE_PRODUCT_PROMOTION,
      sourceKind: PushBroadcastSourceKind.ECOMMERCE_PROMOTION,
      campaignBusinessKey: `old:stop:${i}:${Date.now()}`,
      status: JobStatus.COMPLETED,
      completedAt,
      fanoutStopReason: "PRODUCT_NOT_PUBLISHED",
      fanoutStopRecoveryCompletedAt: completedAt,
    });
  }
  await PushBroadcast.insertMany(backfillDocs);

  const newBroadcastId = createId("pb-new");
  const newCampaignId = createId("epcm-new");
  const newKey = `new:interrupt:${Date.now()}`;
  await PushBroadcast.create({
    _id: newBroadcastId,
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "New",
    body: "B",
    audience: "ALL_DEVICES",
    messageType: MessageType.ECOMMERCE_PRODUCT_PROMOTION,
    sourceKind: PushBroadcastSourceKind.ECOMMERCE_PROMOTION,
    campaignBusinessKey: newKey,
    status: JobStatus.COMPLETED,
    completedAt: new Date(),
    fanoutStopReason: "CATEGORY_INACTIVE",
  });
  await EcommercePromotionCampaign.create({
    _id: newCampaignId,
    tenantId: tenant._id,
    businessKey: newKey,
    kind: EcommercePromotionKind.MANUAL_PRODUCT,
    status: EcommercePromotionCampaignStatus.SENDING,
    broadcastId: newBroadcastId,
    title: "New",
    body: "B",
    audience: "ALL_DEVICES",
    requestedBy: user._id,
  });

  const first = await recoverIncompletePromotionBroadcastStops(50);
  assert.equal(first.recovered, 1);
  const campaign = await EcommercePromotionCampaign.findById(newCampaignId).lean();
  assert.equal(campaign.status, EcommercePromotionCampaignStatus.CANCELLED);
});

test("stale worker cannot persist NOT_DUE deferral", async () => {
  const { tenant, user } = await seedTenantUser({});
  const broadcastId = createId("pb");
  const resumeAt = new Date(Date.now() + 60_000);
  await PushBroadcast.create({
    _id: broadcastId,
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    messageType: MessageType.ECOMMERCE_PRODUCT_PROMOTION,
    sourceKind: PushBroadcastSourceKind.ECOMMERCE_PROMOTION,
    status: JobStatus.PROCESSING,
    leaseOwner: "owner-b",
  });

  const result = await scheduleFanoutContinuationAt({
    broadcastId,
    tenantId: tenant._id,
    leaseToken: "owner-a",
    resumeAt,
    businessYmd: "2026-06-15",
  });
  assert.equal(result.deferred, false);
  assert.equal(result.stale, true);
  const row = await PushBroadcast.findById(broadcastId).lean();
  assert.equal(row.leaseOwner, "owner-b");
  assert.equal(row.fanoutResumeAt ?? null, null);
});

test("fanout recovery filter combines scheduling eligibility and lease availability", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");
  const filter = buildActiveFanoutRecoveryFilter(now);
  assert.ok(Array.isArray(filter.$and));
  assert.equal(filter.$and.length, 2);
  assert.ok(filter.$and[0].$or);
  assert.ok(filter.$and[1].$or);
  assert.deepEqual(filter.$and[1].$or.map((c) => Object.keys(c)[0]), [
    "leaseExpiresAt",
    "leaseOwner",
    "leaseOwner",
  ]);
});

test("future deferral recovery schedules delayed work not immediate chunk", async () => {
  setCalendarDateOverrideForTests("2026-06-14");
  const { tenant, user } = await seedTenantUser({});
  const broadcastId = createId("pb");
  const resumeAt = resolveFanoutNotDueResumeAt({ schemeEffectiveDate: "2026-06-15" });
  assert.ok(resumeAt);
  assert.ok(isFutureFanoutDeferral({ fanoutResumeAt: resumeAt }));
  await PushBroadcast.create({
    _id: broadcastId,
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "Rate",
    body: "Body",
    audience: "ALL_DEVICES",
    messageType: MessageType.SCHEME_GOLD_RATE_UPDATED,
    sourceKind: PushBroadcastSourceKind.GOLD_RATE_NOTIFICATION,
    status: JobStatus.QUEUED,
    fanoutContinuationPending: true,
    fanoutResumeAt: resumeAt,
    schemeEffectiveDate: "2026-06-15",
  });

  const recovery = await recoverActivePushBroadcastFanouts({ limit: 10 });
  assert.equal(recovery.scanned, 1);
  assert.equal(recovery.delayed, 1);
  assert.equal(recovery.enqueued, 0);
});

test("active lease excludes broadcast from recovery scan", async () => {
  const { tenant, user } = await seedTenantUser({});
  const broadcastId = createId("pb");
  await PushBroadcast.create({
    _id: broadcastId,
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    status: JobStatus.QUEUED,
    fanoutContinuationPending: true,
    leaseOwner: "live-worker",
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  const recovery = await recoverActivePushBroadcastFanouts({ limit: 10 });
  assert.equal(recovery.scanned, 0);
});

test("NOT_DUE scheme fanout persists fanoutResumeAt at IST business-day start", async () => {
  setCalendarDateOverrideForTests("2026-06-14");
  const { tenant, user } = await seedTenantUser({});
  const broadcastId = createId("pb");
  const businessKey = `scheme:notdue:${Date.now()}`;
  const broadcast = await PushBroadcast.create({
    _id: broadcastId,
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "Rate",
    body: "Body",
    audience: "ALL_DEVICES",
    messageType: MessageType.SCHEME_GOLD_RATE_UPDATED,
    sourceKind: PushBroadcastSourceKind.GOLD_RATE_NOTIFICATION,
    campaignBusinessKey: businessKey,
    status: JobStatus.QUEUED,
    schemeEffectiveDate: "2026-06-15",
    rateId: createId("grt"),
  });
  await EcommercePromotionCampaign.create({
    _id: createId("epcm"),
    tenantId: tenant._id,
    businessKey,
    kind: EcommercePromotionKind.SCHEME_GOLD_RATE,
    status: EcommercePromotionCampaignStatus.SENDING,
    broadcastId,
    title: "Rate",
    body: "Body",
    audience: "ALL_DEVICES",
    requestedBy: user._id,
    schemeEffectiveDate: "2026-06-15",
    rateId: createId("grt"),
  });

  const resumeAt = resolveFanoutNotDueResumeAt(broadcast.toObject());
  assert.ok(resumeAt);
  assert.equal(fanoutDueJobId(broadcastId, resumeAt), `${broadcastId}-fanout-due-2026-06-15`);

  await processPushBroadcastFanout(broadcastId, "not-due-worker");
  const row = await PushBroadcast.findById(broadcastId).lean();
  assert.ok(row.fanoutResumeAt);
  assert.equal(new Date(row.fanoutResumeAt).getTime(), resumeAt.getTime());
  assert.equal(row.fanoutContinuationPending, true);
  const campaign = await EcommercePromotionCampaign.findOne({ businessKey }).lean();
  assert.equal(campaign.status, EcommercePromotionCampaignStatus.SENDING);

  const dueJobId = fanoutDueJobId(broadcastId, resumeAt, "2026-06-15");
  assert.notEqual(dueJobId, `${broadcastId}-fanout-start`);

  const recovery = await recoverActivePushBroadcastFanouts({ limit: 10 });
  assert.ok(recovery.scanned >= 1);
  assert.ok(recovery.delayed >= 1);
  assert.equal(recovery.enqueued, 0);
});

test("historical cancelled campaigns reconcile regardless of skippedReason", async () => {
  const { tenant, user } = await seedTenantUser({});
  const broadcastId = createId("pb");
  const campaignId = createId("epcm");
  const businessKey = `legacy:cancel:${Date.now()}`;
  await PushBroadcast.create({
    _id: broadcastId,
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    messageType: MessageType.ECOMMERCE_PRODUCT_PROMOTION,
    sourceKind: PushBroadcastSourceKind.ECOMMERCE_PROMOTION,
    campaignBusinessKey: businessKey,
    status: JobStatus.COMPLETED,
    completedAt: new Date(),
    fanoutStopReason: "LEGACY_MANUAL",
    error: "LEGACY_MANUAL",
  });
  await EcommercePromotionCampaign.create({
    _id: campaignId,
    tenantId: tenant._id,
    businessKey,
    kind: EcommercePromotionKind.MANUAL_PRODUCT,
    status: EcommercePromotionCampaignStatus.CANCELLED,
    skippedReason: "LEGACY_MANUAL",
    broadcastId,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    requestedBy: user._id,
    stats: { eligibleCustomers: 1, messagesQueued: 0, delivered: 0, failed: 0, pending: 0 },
  });
  await Message.create({
    _id: createId("msg"),
    tenantId: tenant._id,
    customerId: createId("customer"),
    type: MessageType.ECOMMERCE_PRODUCT_PROMOTION,
    channel: MessageChannel.PUSH,
    templateKey: MessageType.ECOMMERCE_PRODUCT_PROMOTION,
    dispatchPriority: 10,
    status: MessageStatus.QUEUED,
    templateParams: { broadcastId, title: "T", body: "B" },
  });

  const pending = await listCampaignsForDispatchReconciliation(20);
  assert.ok(pending.some((row) => row._id === campaignId));

  await runEcommercePromotionMaintenance();
  let row = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(row.status, EcommercePromotionCampaignStatus.CANCELLED);
  assert.equal(row.skippedReason, "LEGACY_MANUAL");
  assert.equal(row.stats.pending, 1);

  await Message.updateMany(
    { tenantId: tenant._id, "templateParams.broadcastId": broadcastId },
    { $set: { status: MessageStatus.SENT } },
  );
  await reconcilePromotionCampaignDispatch(campaignId, tenant._id);
  row = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(row.stats.delivered, 1);
  assert.equal(row.stats.pending, 0);
  assert.ok(row.dispatchReconciledAt);
});

test("cancelled campaign with null skippedReason preserves reason through reconciliation", async () => {
  const { tenant, user } = await seedTenantUser({});
  const broadcastId = createId("pb");
  const campaignId = createId("epcm");
  const businessKey = `null:reason:${Date.now()}`;
  await PushBroadcast.create({
    _id: broadcastId,
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    status: JobStatus.COMPLETED,
    completedAt: new Date(),
    campaignBusinessKey: businessKey,
    sourceKind: PushBroadcastSourceKind.ECOMMERCE_PROMOTION,
    messageType: MessageType.ECOMMERCE_PRODUCT_PROMOTION,
  });
  await EcommercePromotionCampaign.create({
    _id: campaignId,
    tenantId: tenant._id,
    businessKey,
    kind: EcommercePromotionKind.MANUAL_PRODUCT,
    status: EcommercePromotionCampaignStatus.CANCELLED,
    broadcastId,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    requestedBy: user._id,
  });

  await reconcilePromotionCampaignDispatch(campaignId, tenant._id);
  const row = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(row.status, EcommercePromotionCampaignStatus.CANCELLED);
  assert.ok(row.skippedReason == null || row.skippedReason === undefined);
  assert.ok(row.dispatchReconciledAt);
});
