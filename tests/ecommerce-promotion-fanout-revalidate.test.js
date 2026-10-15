import test from "node:test";
import assert from "node:assert/strict";
import {
  CustomerStatus,
  DevicePrincipalType,
  DeviceRegistrationStatus,
  EcommercePriceMode,
  EcommerceProductStatus,
  EcommercePromotionCampaignStatus,
  EcommercePromotionKind,
  JobStatus,
  MessageType,
  PlanTier,
  PushBroadcastSourceKind,
} from "../src/constants/enums.js";
import { Permission } from "../src/constants/permissions.js";
import { createId } from "../src/lib/ids.js";
import { fcmTokenRecordFromPlain } from "../src/lib/fcm-tokens.js";
import {
  Customer,
  DeviceRegistration,
  EcommerceCategory,
  EcommerceProduct,
  EcommercePromotionCampaign,
  PushBroadcast,
  Tenant,
} from "../src/models/index.js";
import { processPushBroadcastFanout } from "../src/services/push-broadcast.service.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

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

test("fanout revalidation stops when product unpublished before chunk", async () => {
  const { tenant, user, branch } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const category = await EcommerceCategory.create({
    tenantId: tenant._id,
    name: "Ear",
    slug: "ear",
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
      name: "Stud",
      categoryId: category._id,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 50_000 },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.publishProduct({
    ...reqCtx,
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  const customerId = createId("customer");
  await Customer.create({
    _id: customerId,
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "C1",
    name: "Buyer",
    mobile: "+919900000001",
    status: CustomerStatus.ACTIVE,
  });
  const token = fcmTokenRecordFromPlain({
    fcmToken: "tok-fanout-reval",
    deviceId: "dev-fanout-reval",
    platform: "android",
  });
  await DeviceRegistration.create({
    _id: createId("dvr"),
    tenantId: tenant._id,
    principalType: DevicePrincipalType.CUSTOMER,
    principalId: customerId,
    deviceId: "dev-fanout-reval",
    platform: "android",
    tokenHash: token.tokenHash,
    tokenSealed: token.tokenSealed,
    status: DeviceRegistrationStatus.ACTIVE,
    version: 1,
  });

  const businessKey = `manual-product:reval:${Date.now()}`;
  const broadcastId = createId("pb");
  const campaignId = createId("epcm");
  await EcommercePromotionCampaign.create({
    _id: campaignId,
    tenantId: tenant._id,
    businessKey,
    kind: EcommercePromotionKind.MANUAL_PRODUCT,
    productId: product.id,
    status: EcommercePromotionCampaignStatus.SENDING,
    broadcastId,
    title: "Promo",
    body: "Body",
    audience: "ALL_DEVICES",
    requestedBy: user._id,
  });
  await PushBroadcast.create({
    _id: broadcastId,
    tenantId: tenant._id,
    requestedBy: user._id,
    title: "Promo",
    body: "Body",
    audience: "ALL_DEVICES",
    messageType: MessageType.ECOMMERCE_PRODUCT_PROMOTION,
    sourceKind: PushBroadcastSourceKind.ECOMMERCE_PROMOTION,
    campaignBusinessKey: businessKey,
    productId: product.id,
    status: JobStatus.QUEUED,
    stats: { audienceCount: 1 },
  });

  await EcommerceProduct.updateOne(
    { _id: product.id, tenantId: tenant._id },
    { $set: { status: EcommerceProductStatus.DRAFT } },
  );

  await processPushBroadcastFanout(broadcastId, "reval-worker");

  const broadcast = await PushBroadcast.findById(broadcastId).lean();
  assert.equal(broadcast.status, JobStatus.COMPLETED);
  assert.equal(broadcast.error, "PRODUCT_NOT_PUBLISHED");
  const campaign = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(campaign.status, EcommercePromotionCampaignStatus.CANCELLED);
  assert.equal(campaign.skippedReason, "PRODUCT_NOT_PUBLISHED");
});
