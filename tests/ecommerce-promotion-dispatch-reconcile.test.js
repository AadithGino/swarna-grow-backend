import test from "node:test";
import assert from "node:assert/strict";
import {
  EcommercePromotionCampaignStatus,
  EcommercePromotionKind,
  JobStatus,
  MessageChannel,
  MessageStatus,
  MessageType,
  PlanTier,
  PushBroadcastSourceKind,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import {
  EcommercePromotionCampaign,
  Message,
  PushBroadcast,
  Tenant,
} from "../src/models/index.js";
import {
  listCampaignsForDispatchReconciliation,
  reconcilePromotionCampaignDispatch,
  runEcommercePromotionMaintenance,
  stopPromotionBroadcastFanout,
} from "../src/services/ecommerce-promotion-delivery.service.js";
import { processPushBroadcastFanout } from "../src/services/push-broadcast.service.js";
import { setCalendarDateOverrideForTests, resetCalendarDateOverrideForTests } from "../src/lib/date.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  resetCalendarDateOverrideForTests();
});

async function seedBroadcastCampaign({
  tenantId,
  userId,
  businessKey,
  broadcastId,
  campaignId,
  campaignStatus = EcommercePromotionCampaignStatus.CANCELLED,
  skippedReason = "PRODUCT_NOT_PUBLISHED",
  broadcastStatus = JobStatus.COMPLETED,
  stats = { messagesQueued: 0, delivered: 0, failed: 0, pending: 0 },
  schemeEffectiveDate = null,
}) {
  await PushBroadcast.create({
    _id: broadcastId,
    tenantId,
    requestedBy: userId,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    messageType: schemeEffectiveDate
      ? MessageType.SCHEME_GOLD_RATE_UPDATED
      : MessageType.ECOMMERCE_PRODUCT_PROMOTION,
    sourceKind: schemeEffectiveDate
      ? PushBroadcastSourceKind.GOLD_RATE_NOTIFICATION
      : PushBroadcastSourceKind.ECOMMERCE_PROMOTION,
    campaignBusinessKey: businessKey,
    status: broadcastStatus,
    completedAt: broadcastStatus === JobStatus.COMPLETED ? new Date() : undefined,
    stats: { audienceCount: 2, messagesQueued: stats.messagesQueued },
    schemeEffectiveDate: schemeEffectiveDate ?? undefined,
    rateId: schemeEffectiveDate ? createId("grt") : undefined,
  });
  await EcommercePromotionCampaign.create({
    _id: campaignId,
    tenantId,
    businessKey,
    kind: schemeEffectiveDate
      ? EcommercePromotionKind.SCHEME_GOLD_RATE
      : EcommercePromotionKind.MANUAL_PRODUCT,
    status: campaignStatus,
    skippedReason,
    broadcastId,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    requestedBy: userId,
    stats: {
      eligibleCustomers: 2,
      messagesQueued: stats.messagesQueued,
      delivered: stats.delivered,
      failed: stats.failed,
      pending: stats.pending,
    },
    schemeEffectiveDate: schemeEffectiveDate ?? undefined,
    rateId: schemeEffectiveDate ? createId("grt") : undefined,
  });
}

test("maintenance reconciles stopped CANCELLED campaigns until messages are terminal", async () => {
  const { tenant, user } = await seedTenantUser({});
  const broadcastId = createId("pb");
  const campaignId = createId("epcm");
  const businessKey = `stop:stats:${Date.now()}`;
  await seedBroadcastCampaign({
    tenantId: tenant._id,
    userId: user._id,
    businessKey,
    broadcastId,
    campaignId,
    stats: { messagesQueued: 2, delivered: 0, failed: 0, pending: 0 },
  });
  const msgBase = {
    tenantId: tenant._id,
    customerId: createId("customer"),
    type: MessageType.ECOMMERCE_PRODUCT_PROMOTION,
    channel: MessageChannel.PUSH,
    templateKey: MessageType.ECOMMERCE_PRODUCT_PROMOTION,
    dispatchPriority: 10,
    templateParams: { broadcastId, title: "T", body: "B" },
  };
  await Message.create([
    { ...msgBase, _id: createId("msg"), status: MessageStatus.QUEUED },
    { ...msgBase, _id: createId("msg"), customerId: createId("customer"), status: MessageStatus.QUEUED },
  ]);

  const pending = await listCampaignsForDispatchReconciliation(10);
  assert.ok(pending.some((row) => row._id === campaignId));

  await runEcommercePromotionMaintenance();
  let row = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(row.status, EcommercePromotionCampaignStatus.CANCELLED);
  assert.equal(row.skippedReason, "PRODUCT_NOT_PUBLISHED");
  assert.equal(row.stats.pending, 2);
  assert.ok(!row.dispatchReconciledAt);

  await Message.updateMany(
    { tenantId: tenant._id, "templateParams.broadcastId": broadcastId },
    { $set: { status: MessageStatus.SENT } },
  );
  await runEcommercePromotionMaintenance();
  row = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(row.status, EcommercePromotionCampaignStatus.CANCELLED);
  assert.equal(row.skippedReason, "PRODUCT_NOT_PUBLISHED");
  assert.equal(row.stats.delivered, 2);
  assert.equal(row.stats.pending, 0);
  assert.ok(row.dispatchReconciledAt);

  const stillPending = await listCampaignsForDispatchReconciliation(10);
  assert.ok(!stillPending.some((r) => r._id === campaignId));

  await runEcommercePromotionMaintenance();
  row = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(row.stats.delivered, 2);
});

test("reconcile refreshs stats for stale pending zero on stopped campaign", async () => {
  const { tenant, user } = await seedTenantUser({});
  const broadcastId = createId("pb");
  const campaignId = createId("epcm");
  const businessKey = `stale:stats:${Date.now()}`;
  await seedBroadcastCampaign({
    tenantId: tenant._id,
    userId: user._id,
    businessKey,
    broadcastId,
    campaignId,
    stats: { messagesQueued: 0, delivered: 0, failed: 0, pending: 0 },
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

  const result = await reconcilePromotionCampaignDispatch(campaignId, tenant._id);
  assert.equal(result.stats.pending, 1);
  const row = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(row.stats.pending, 1);
  assert.equal(row.status, EcommercePromotionCampaignStatus.CANCELLED);
});

test("scheme fanout crossing midnight uses STALE_BUSINESS_DATE cancellation path", async () => {
  setCalendarDateOverrideForTests("2026-06-15");
  const { tenant, user } = await seedTenantUser({});
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "subscription.planFeaturesSnapshot": { ecommerce: true }, "subscription.tier": PlanTier.PRO } },
  );
  const broadcastId = createId("pb");
  const campaignId = createId("epcm");
  const businessKey = `scheme:midnight:${Date.now()}`;
  const rateId = createId("grt");
  await PushBroadcast.create({
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
    rateId,
    stats: { audienceCount: 1, messagesQueued: 1 },
  });
  await EcommercePromotionCampaign.create({
    _id: campaignId,
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
    rateId,
    stats: { eligibleCustomers: 1, messagesQueued: 1, delivered: 0, failed: 0, pending: 1 },
  });
  await Message.create({
    _id: createId("msg"),
    tenantId: tenant._id,
    customerId: createId("customer"),
    type: MessageType.SCHEME_GOLD_RATE_UPDATED,
    channel: MessageChannel.PUSH,
    templateKey: MessageType.SCHEME_GOLD_RATE_UPDATED,
    dispatchPriority: 10,
    status: MessageStatus.QUEUED,
    templateParams: { broadcastId, title: "Rate", body: "Body" },
  });

  setCalendarDateOverrideForTests("2026-06-16");
  await processPushBroadcastFanout(broadcastId, "midnight-worker");

  const broadcast = await PushBroadcast.findById(broadcastId).lean();
  assert.equal(broadcast.status, JobStatus.COMPLETED);
  assert.equal(broadcast.error, "STALE_BUSINESS_DATE");
  const campaign = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(campaign.status, EcommercePromotionCampaignStatus.CANCELLED);
  assert.equal(campaign.skippedReason, "STALE_BUSINESS_DATE");

  await Message.updateOne(
    { tenantId: tenant._id, "templateParams.broadcastId": broadcastId },
    { $set: { status: MessageStatus.SENT } },
  );
  await runEcommercePromotionMaintenance();
  const settled = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(settled.skippedReason, "STALE_BUSINESS_DATE");
  assert.equal(settled.stats.delivered, 1);
  assert.equal(settled.stats.pending, 0);
  assert.ok(settled.dispatchReconciledAt);

  setCalendarDateOverrideForTests("2026-06-16");
  await processPushBroadcastFanout(broadcastId, "midnight-retry");
  assert.equal(await Message.countDocuments({ tenantId: tenant._id, "templateParams.broadcastId": broadcastId }), 1);
});

test("future scheme business date remains recoverable (NOT_DUE does not cancel)", async () => {
  setCalendarDateOverrideForTests("2026-06-14");
  const { tenant, user } = await seedTenantUser({});
  const broadcastId = createId("pb");
  const campaignId = createId("epcm");
  const businessKey = `scheme:future:${Date.now()}`;
  await PushBroadcast.create({
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
    _id: campaignId,
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

  await processPushBroadcastFanout(broadcastId, "early-worker");
  const broadcast = await PushBroadcast.findById(broadcastId).lean();
  assert.ok([JobStatus.QUEUED, JobStatus.PROCESSING].includes(broadcast.status));
  assert.notEqual(broadcast.error, "NOT_DUE");
  assert.ok(broadcast.fanoutResumeAt);
  assert.equal(broadcast.fanoutContinuationPending, true);
  const campaign = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(campaign.status, EcommercePromotionCampaignStatus.SENDING);
  assert.equal(campaign.skippedReason ?? null, null);
});

test("stopPromotionBroadcastFanout does not resume fanout or create messages", async () => {
  const { tenant, user } = await seedTenantUser({});
  const broadcastId = createId("pb");
  const campaignId = createId("epcm");
  const businessKey = `stop:helper:${Date.now()}`;
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
    leaseOwner: "lease-test",
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
  const beforeMsgs = await Message.countDocuments({ tenantId: tenant._id });
  await stopPromotionBroadcastFanout({
    broadcastId,
    tenantId: tenant._id,
    leaseToken: "lease-test",
    reason: "PRODUCT_NOT_PUBLISHED",
  });
  const afterMsgs = await Message.countDocuments({ tenantId: tenant._id });
  assert.equal(beforeMsgs, afterMsgs);
  const row = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(row.status, EcommercePromotionCampaignStatus.CANCELLED);
  assert.equal(row.skippedReason, "PRODUCT_NOT_PUBLISHED");
});
