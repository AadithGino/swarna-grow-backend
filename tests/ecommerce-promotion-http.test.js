import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommercePriceMode,
  EcommerceProductStatus,
  EcommercePromotionCampaignStatus,
  PlanTier,
} from "../src/constants/enums.js";
import { Permission } from "../src/constants/permissions.js";
import {
  EcommerceCategory,
  EcommercePromotionCampaign,
  Tenant,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import {
  deliverPromotionCampaign,
  offerRevisionDigest,
} from "../src/services/ecommerce-promotion.service.js";
import { withTransaction } from "../src/lib/transaction.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function enableEcommerce(tenant, { storeOn = true } = {}) {
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot": { ecommerce: true },
        "subscription.tier": PlanTier.PRO,
        "operations.ecommerceEnabled": storeOn,
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

async function seedCategory(tenantId) {
  return EcommerceCategory.create({
    _id: createId("ecat"),
    tenantId,
    name: "Rings",
    slug: "rings",
    active: true,
  });
}

async function createDraftProduct(reqCtx, categoryId) {
  return ecommerce.createProduct({
    ...reqCtx,
    body: {
      name: "Test Ring",
      slug: "test-ring",
      categoryId,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 100_000 },
      taxClassification: "GST_3",
    },
  });
}

test("publish with notification.enabled denied without message.send", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const category = await seedCategory(tenant._id);
  const perms = [Permission.ECOMMERCE_READ, Permission.ECOMMERCE_WRITE];
  const reqCtx = {
    auth: { tenantId: tenant._id, id: user._id, permissions: perms },
    tenant: tenantCtx(tenant),
    scope: { tenantId: tenant._id },
  };
  await ecommerce.putTaxSettings({
    ...reqCtx,
    body: { rates: [{ code: "GST_3", rateBps: 300, active: true }], defaultClassification: "GST_3" },
  });
  const product = await createDraftProduct(reqCtx, category._id);
  const res = await request(app)
    .post(`/api/v1/admin/ecommerce/products/${product.id}/publish`)
    .set({
      authorization: `Bearer ${bearerFor(user, perms)}`,
      "x-idempotency-key": createId("idem"),
    })
    .send({
      expectedVersion: 1,
      notification: { enabled: true },
    });
  assert.equal(res.status, 403);
});

test("patch without notification succeeds with ecommerce.write only", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const category = await seedCategory(tenant._id);
  const reqCtx = {
    auth: { tenantId: tenant._id, id: user._id, permissions: [Permission.ECOMMERCE_WRITE, Permission.ECOMMERCE_READ] },
    tenant: tenantCtx(tenant),
    scope: { tenantId: tenant._id },
    params: {},
  };
  await ecommerce.putTaxSettings({
    ...reqCtx,
    body: { rates: [{ code: "GST_3", rateBps: 300, active: true }], defaultClassification: "GST_3" },
  });
  const product = await createDraftProduct(reqCtx, category._id);
  const res = await request(app)
    .patch(`/api/v1/admin/ecommerce/products/${product.id}`)
    .set({ authorization: `Bearer ${bearerFor(user, [Permission.ECOMMERCE_WRITE, Permission.ECOMMERCE_READ])}` })
    .send({ expectedVersion: 1, name: "Renamed Ring" });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.name, "Renamed Ring");
});

test("notification preview rejected when store disabled", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant, { storeOn: false });
  const category = await seedCategory(tenant._id);
  const fullPerms = [Permission.ECOMMERCE_READ, Permission.ECOMMERCE_WRITE, Permission.MESSAGE_SEND];
  const reqCtx = {
    auth: { tenantId: tenant._id, id: user._id, permissions: fullPerms },
    tenant: { ...tenantCtx(tenant), operations: { ecommerceEnabled: false } },
    scope: { tenantId: tenant._id },
  };
  await ecommerce.putTaxSettings({
    ...reqCtx,
    body: { rates: [{ code: "GST_3", rateBps: 300, active: true }], defaultClassification: "GST_3" },
  });
  const product = await createDraftProduct(reqCtx, category._id);
  await ecommerce.publishProduct({
    ...reqCtx,
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  const res = await request(app)
    .post(`/api/v1/admin/ecommerce/products/${product.id}/notifications/preview`)
    .set({ authorization: `Bearer ${bearerFor(user, fullPerms)}` })
    .send({});
  assert.equal(res.status, 403);
});

test("preview generates default title and body when copy omitted", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const category = await seedCategory(tenant._id);
  const perms = [Permission.ECOMMERCE_READ, Permission.ECOMMERCE_WRITE, Permission.MESSAGE_SEND];
  const reqCtx = {
    auth: { tenantId: tenant._id, id: user._id, permissions: perms },
    tenant: tenantCtx(tenant),
    scope: { tenantId: tenant._id },
  };
  await ecommerce.putTaxSettings({
    ...reqCtx,
    body: { rates: [{ code: "GST_3", rateBps: 300, active: true }], defaultClassification: "GST_3" },
  });
  const product = await createDraftProduct(reqCtx, category._id);
  await ecommerce.publishProduct({
    ...reqCtx,
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  const res = await request(app)
    .post(`/api/v1/admin/ecommerce/products/${product.id}/notifications/preview`)
    .set({ authorization: `Bearer ${bearerFor(user, perms)}` })
    .send({});
  assert.equal(res.status, 200);
  assert.ok(res.body.data.title.length >= 2);
  assert.ok(res.body.data.body.length >= 2);
  assert.match(res.body.data.body, /Test Ring/);
});

test("rolled-back product change leaves no promotion campaign", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const category = await seedCategory(tenant._id);
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
  const product = await createDraftProduct(reqCtx, category._id);
  try {
    await withTransaction(async (session) => {
      const { persistCampaignIntent } = await import("../src/services/ecommerce-promotion.service.js");
      await persistCampaignIntent(session, reqCtx, {
        kind: "NEW_ARRIVAL",
        businessKey: `new-arrival:${product.id}`,
        product: { _id: product.id, slug: product.slug, name: product.name, priceMode: product.priceMode },
        title: null,
        body: null,
        audience: "ALL_DEVICES",
      });
      throw new Error("ROLLBACK");
    });
  } catch (error) {
    assert.equal(error.message, "ROLLBACK");
  }
  const count = await EcommercePromotionCampaign.countDocuments({ tenantId: tenant._id });
  assert.equal(count, 0);
});

test("duplicate business key yields one campaign row", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const category = await seedCategory(tenant._id);
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
  const product = await createDraftProduct(reqCtx, category._id);
  const key = `offer:${product.id}:abc`;
  const { persistCampaignIntent } = await import("../src/services/ecommerce-promotion.service.js");
  const base = {
    kind: "OFFER",
    businessKey: key,
    product: {
      _id: product.id,
      slug: product.slug,
      name: product.name,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 100_000, salePricePaise: 80_000 },
    },
    audience: "ALL_DEVICES",
    offerRevision: "abc",
  };
  await persistCampaignIntent(null, reqCtx, base);
  await persistCampaignIntent(null, reqCtx, base);
  const rows = await EcommercePromotionCampaign.find({ tenantId: tenant._id, businessKey: key }).lean();
  assert.equal(rows.length, 1);
});

test("scheduled fixed-price campaign stays QUEUED until due", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const category = await seedCategory(tenant._id);
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
  const product = await createDraftProduct(reqCtx, category._id);
  const future = new Date(Date.now() + 3600_000);
  const { persistCampaignIntent } = await import("../src/services/ecommerce-promotion.service.js");
  const { campaignId } = await persistCampaignIntent(null, reqCtx, {
    kind: "OFFER",
    businessKey: `offer:${product.id}:sale1`,
    product: {
      _id: product.id,
      slug: product.slug,
      name: product.name,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: {
        basePricePaise: 100_000,
        salePricePaise: 75_000,
        saleStartsAt: future,
      },
    },
    scheduledFor: future,
    offerRevision: "sale1",
    audience: "ALL_DEVICES",
  });
  const before = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(before.status, EcommercePromotionCampaignStatus.QUEUED);
  const early = await deliverPromotionCampaign(campaignId, tenant._id);
  assert.ok(early.skipped || early.cancelled);
});

test("deliver cancels when product unpublished", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const category = await seedCategory(tenant._id);
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
  const product = await createDraftProduct(reqCtx, category._id);
  await ecommerce.publishProduct({
    ...reqCtx,
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  const { persistCampaignIntent } = await import("../src/services/ecommerce-promotion.service.js");
  const { campaignId } = await persistCampaignIntent(null, reqCtx, {
    kind: "MANUAL_PRODUCT",
    businessKey: `manual-product:${product.id}:x`,
    product: {
      _id: product.id,
      slug: product.slug,
      name: product.name,
      priceMode: product.priceMode,
      status: EcommerceProductStatus.PUBLISHED,
    },
    audience: "ALL_DEVICES",
  });
  await ecommerce.patchProduct({
    ...reqCtx,
    params: { productId: product.id },
    body: { expectedVersion: 2, status: EcommerceProductStatus.ARCHIVED },
  });
  const result = await deliverPromotionCampaign(campaignId, tenant._id);
  assert.equal(result.cancelled, true);
  const row = await EcommercePromotionCampaign.findById(campaignId).lean();
  assert.equal(row.status, EcommercePromotionCampaignStatus.CANCELLED);
  assert.equal(row.skippedReason, "PRODUCT_NOT_PUBLISHED");
});

test("offer revision digest is bounded", () => {
  const digest = offerRevisionDigest({
    priceMode: EcommercePriceMode.FIXED,
    fixedPricing: { salePricePaise: 1, saleStartsAt: new Date("2026-01-01") },
  });
  assert.equal(digest.length, 64);
});
