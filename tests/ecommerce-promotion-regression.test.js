import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceMakingChargeMode,
  EcommercePriceMode,
  EcommercePromotionCampaignStatus,
  EcommercePromotionKind,
  JobStatus,
  MessageChannel,
  MessageStatus,
  MessageType,
  PlanTier,
} from "../src/constants/enums.js";
import { Permission } from "../src/constants/permissions.js";
import {
  EcommerceCategory,
  EcommercePromotionCampaign,
  Message,
  PushBroadcast,
  Tenant,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { computeProductPriceEstimate } from "../src/lib/ecommerce-pricing.js";
import {
  suggestOfferPromotionCopy,
} from "../src/lib/ecommerce-promotion-copy.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import {
  aggregateCampaignMessageStats,
  claimCampaignForDelivery,
  deliverPromotionCampaign,
  reconcilePromotionCampaignDispatch,
  releaseCampaignDeliveryLease,
} from "../src/services/ecommerce-promotion-delivery.service.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function enableEcommerce(tenant) {
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot": { ecommerce: true },
        "subscription.tier": PlanTier.PRO,
        "operations.ecommerceEnabled": true,
      },
    },
  );
}

function tenantCtx(tenant) {
  return {
    ...tenant.toObject(),
    subscription: { planFeaturesSnapshot: { ecommerce: true }, tier: PlanTier.PRO },
    operations: { ecommerceEnabled: true },
  };
}

test("making-charge offer copy uses pricing-engine discount fields", () => {
  const product = {
    name: "Bangle",
    priceMode: EcommercePriceMode.GOLD_RATE_BASED,
    purity: "22K",
    goldWeightMg: 10_000,
    makingChargeMode: EcommerceMakingChargeMode.FIXED_PAISE,
    makingCharge: { fixedPaise: 10_000 },
    offer: { type: "PERCENT_OFF", percentBps: 500 },
    taxClassification: "GST_3",
  };
  const estimate = computeProductPriceEstimate({
    product,
    rateRow: { ratePerGramPaise: 600_000, purity: "22K", effectiveAt: new Date("2026-01-01") },
    taxSettings: { version: 1, defaultClassification: "GST_3", rates: [{ code: "GST_3", rateBps: 300, active: true }] },
    atMs: new Date("2026-06-01").getTime(),
  });
  assert.ok((estimate.making?.offerDiscountPaise ?? 0) > 0);
  const copy = suggestOfferPromotionCopy(product, estimate);
  assert.match(copy.body, /making charges/i);
  assert.match(copy.body, /₹/);
});

test("completed fanout with zero messages becomes CANCELLED with NO_ELIGIBLE_RECIPIENTS", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const campaignId = createId("epcm");
  const broadcastId = createId("pb");
  const businessKey = `manual-product:zero:${Date.now()}`;
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
  await PushBroadcast.create({
    _id: broadcastId,
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    status: JobStatus.COMPLETED,
    campaignBusinessKey: businessKey,
    sourceKind: "ECOMMERCE_PROMOTION",
    stats: { audienceCount: 0, messagesQueued: 0 },
    completedAt: new Date(),
  });
  await reconcilePromotionCampaignDispatch(campaignId, tenant._id);
  const row = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(row.status, EcommercePromotionCampaignStatus.CANCELLED);
  assert.equal(row.skippedReason, "NO_ELIGIBLE_RECIPIENTS");
  assert.equal(row.stats.messagesQueued, 0);
});

test("reconciliation preserves terminal stop reason from fanout revalidation", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const campaignId = createId("epcm");
  const broadcastId = createId("pb");
  const businessKey = `offer:stop:${Date.now()}`;
  await EcommercePromotionCampaign.create({
    _id: campaignId,
    tenantId: tenant._id,
    businessKey,
    kind: EcommercePromotionKind.OFFER,
    status: EcommercePromotionCampaignStatus.CANCELLED,
    skippedReason: "PRODUCT_NOT_PUBLISHED",
    broadcastId,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    requestedBy: user._id,
  });
  await PushBroadcast.create({
    _id: broadcastId,
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    status: JobStatus.COMPLETED,
    campaignBusinessKey: businessKey,
    sourceKind: "ECOMMERCE_PROMOTION",
    stats: { audienceCount: 0, messagesQueued: 0 },
    completedAt: new Date(),
  });
  await reconcilePromotionCampaignDispatch(campaignId, tenant._id);
  const row = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(row.status, EcommercePromotionCampaignStatus.CANCELLED);
  assert.equal(row.skippedReason, "PRODUCT_NOT_PUBLISHED");
});

test("completed fanout with queued messages stays SENDING until dispatch finishes", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const campaignId = createId("epcm");
  const broadcastId = createId("pb");
  const businessKey = `manual-product:x:${Date.now()}`;
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
    stats: { messagesQueued: 2, delivered: 0, failed: 0, pending: 2 },
  });
  await PushBroadcast.create({
    _id: broadcastId,
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    status: JobStatus.COMPLETED,
    campaignBusinessKey: businessKey,
    sourceKind: "ECOMMERCE_PROMOTION",
    stats: { audienceCount: 2, messagesQueued: 2, delivered: 0, failed: 0 },
    completedAt: new Date(),
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
    { ...msgBase, _id: createId("msg"), status: MessageStatus.QUEUED },
  ]);
  await reconcilePromotionCampaignDispatch(campaignId, tenant._id);
  const row = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(row.status, EcommercePromotionCampaignStatus.SENDING);
  assert.equal(row.stats.pending, 2);
  assert.equal(row.stats.delivered, 0);
});

test("reconciliation marks SENT when all messages reach successful terminals", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const campaignId = createId("epcm");
  const broadcastId = createId("pb");
  const businessKey = `manual-product:y:${Date.now()}`;
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
  await PushBroadcast.create({
    _id: broadcastId,
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    status: JobStatus.COMPLETED,
    campaignBusinessKey: businessKey,
    sourceKind: "ECOMMERCE_PROMOTION",
    stats: { audienceCount: 2, messagesQueued: 2, delivered: 1, failed: 1 },
    completedAt: new Date(),
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
    { ...msgBase, _id: createId("msg"), status: MessageStatus.SENT },
    { ...msgBase, _id: createId("msg"), customerId: createId("customer"), status: MessageStatus.FAILED },
  ]);
  await reconcilePromotionCampaignDispatch(campaignId, tenant._id);
  const row = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(row.status, EcommercePromotionCampaignStatus.SENT);
  assert.equal(row.stats.delivered, 1);
  assert.equal(row.stats.failed, 1);
  assert.equal(row.stats.pending, 0);
});

test("stale SENDING without broadcast recovers via claim and release", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const campaignId = createId("epcm");
  const past = new Date(Date.now() - 60_000);
  await EcommercePromotionCampaign.create({
    _id: campaignId,
    tenantId: tenant._id,
    businessKey: `offer:recover:${Date.now()}`,
    kind: EcommercePromotionKind.OFFER,
    status: EcommercePromotionCampaignStatus.SENDING,
    broadcastId: null,
    deliveryLeaseOwner: "epcm:stale",
    deliveryLeaseExpiresAt: past,
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    requestedBy: user._id,
    scheduledFor: null,
  });
  const claim = await claimCampaignForDelivery(campaignId, tenant._id, new Date());
  assert.ok(claim.campaign);
  assert.ok(claim.recoveredStale);
  await releaseCampaignDeliveryLease(campaignId, tenant._id, claim.leaseOwner, { requeue: true });
  const row = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(row.status, EcommercePromotionCampaignStatus.QUEUED);
  assert.equal(row.deliveryLeaseOwner, null);
});

test("aggregateCampaignMessageStats counts pending vs terminal", async () => {
  const { tenant } = await seedTenantUser({});
  const broadcastId = createId("pb");
  await Message.create([
    {
      _id: createId("msg"),
      tenantId: tenant._id,
      customerId: createId("customer"),
      type: MessageType.MANUAL_PUSH,
      channel: MessageChannel.PUSH,
      templateKey: MessageType.MANUAL_PUSH,
      dispatchPriority: 0,
      status: MessageStatus.QUEUED,
      templateParams: { broadcastId, title: "T", body: "B" },
    },
    {
      _id: createId("msg"),
      tenantId: tenant._id,
      customerId: createId("customer"),
      type: MessageType.MANUAL_PUSH,
      channel: MessageChannel.PUSH,
      templateKey: MessageType.MANUAL_PUSH,
      dispatchPriority: 0,
      status: MessageStatus.FAILED,
      templateParams: { broadcastId, title: "T", body: "B" },
    },
  ]);
  const stats = await aggregateCampaignMessageStats(tenant._id, broadcastId);
  assert.equal(stats.messagesQueued, 2);
  assert.equal(stats.failed, 1);
  assert.equal(stats.pending, 1);
  assert.equal(stats.allTerminal, false);
});

test("VERSION_CONFLICT returns current product version in details", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const category = await EcommerceCategory.create({
    _id: createId("ecat"),
    tenantId: tenant._id,
    name: "Rings",
    slug: "rings",
    active: true,
  });
  const perms = [Permission.ECOMMERCE_WRITE, Permission.ECOMMERCE_READ];
  const reqCtx = {
    auth: { tenantId: tenant._id, id: user._id, permissions: perms },
    tenant: tenantCtx(tenant),
    scope: { tenantId: tenant._id },
  };
  await ecommerce.putTaxSettings({
    ...reqCtx,
    body: { rates: [{ code: "GST_3", rateBps: 300, active: true }], defaultClassification: "GST_3" },
  });
  const product = await ecommerce.createProduct({
    ...reqCtx,
    body: {
      name: "Test Ring",
      slug: "test-ring",
      categoryId: category._id,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 100_000 },
      taxClassification: "GST_3",
    },
  });
  const res = await request(app)
    .patch(`/api/v1/admin/ecommerce/products/${product.id}`)
    .set({ authorization: `Bearer ${bearerFor(user, perms)}` })
    .send({ expectedVersion: 999, name: "Stale" });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, "VERSION_CONFLICT");
  assert.equal(res.body.error.details.current.version, 1);
  assert.equal(res.body.error.details.current.id, product.id);
});

test("patch product save succeeds when promotion enqueue has no queue", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const category = await EcommerceCategory.create({
    _id: createId("ecat"),
    tenantId: tenant._id,
    name: "Rings",
    slug: "rings",
    active: true,
  });
  const perms = [Permission.ECOMMERCE_WRITE, Permission.MESSAGE_SEND, Permission.ECOMMERCE_READ];
  const reqCtx = {
    auth: { tenantId: tenant._id, id: user._id, permissions: perms },
    tenant: tenantCtx(tenant),
    scope: { tenantId: tenant._id },
  };
  await ecommerce.putTaxSettings({
    ...reqCtx,
    body: { rates: [{ code: "GST_3", rateBps: 300, active: true }], defaultClassification: "GST_3" },
  });
  const draft = await ecommerce.createProduct({
    ...reqCtx,
    body: {
      name: "Offer Ring",
      slug: "offer-ring",
      categoryId: category._id,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 100_000, salePricePaise: 80_000 },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.publishProduct({
    ...reqCtx,
    params: { productId: draft.id },
    body: { expectedVersion: 1 },
  });
  const res = await request(app)
    .patch(`/api/v1/admin/ecommerce/products/${draft.id}`)
    .set({ authorization: `Bearer ${bearerFor(user, perms)}` })
    .send({
      expectedVersion: 2,
      fixedPricing: { basePricePaise: 100_000, salePricePaise: 70_000 },
      notification: { enabled: true, kind: "OFFER" },
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.fixedPricing.salePricePaise, 70_000);
  const promo = res.body.data.promotion;
  assert.equal(promo.intentPersisted, true);
  assert.ok(promo.enqueued === false || promo.enqueueError != null || promo.scheduled === true);
  const campaigns = await EcommercePromotionCampaign.countDocuments({ tenantId: tenant._id, productId: draft.id });
  assert.ok(campaigns >= 1);
});

test("failure after claim releases lease for retry without FAILED status", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const campaignId = createId("epcm");
  await EcommercePromotionCampaign.create({
    _id: campaignId,
    tenantId: tenant._id,
    businessKey: `manual-product:orphan:${Date.now()}`,
    kind: EcommercePromotionKind.MANUAL_PRODUCT,
    status: EcommercePromotionCampaignStatus.QUEUED,
    productId: createId("eprd"),
    title: "T",
    body: "B",
    audience: "ALL_DEVICES",
    requestedBy: user._id,
  });
  const result = await deliverPromotionCampaign(campaignId, tenant._id);
  assert.equal(result.cancelled, true);
  const row = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.notEqual(row.status, EcommercePromotionCampaignStatus.FAILED);
});
