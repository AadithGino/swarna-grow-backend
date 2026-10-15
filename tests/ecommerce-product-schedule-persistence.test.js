import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceMakingChargeMode,
  EcommerceOfferType,
  EcommercePriceMode,
  EcommercePromotionKind,
  PlanTier,
} from "../src/constants/enums.js";
import { Permission } from "../src/constants/permissions.js";
import { EcommerceCategory, EcommercePromotionCampaign, EcommerceProduct } from "../src/models/index.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function enableEcommerce(tenant) {
  const { Tenant } = await import("../src/models/index.js");
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

function isoDate(value) {
  if (value == null) return null;
  return new Date(value).toISOString();
}

test("name-only PATCH preserves fixed sale schedule instants in MongoDB", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const category = await EcommerceCategory.create({
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
  const saleStart = new Date("2026-08-01T10:15:33.000Z");
  const saleEnd = new Date("2026-08-15T18:45:00.000Z");
  const created = await ecommerce.createProduct({
    ...reqCtx,
    body: {
      name: "Scheduled ring",
      slug: "scheduled-ring",
      categoryId: category._id,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: {
        basePricePaise: 200_000,
        salePricePaise: 150_000,
        saleStartsAt: saleStart.toISOString(),
        saleEndsAt: saleEnd.toISOString(),
      },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.patchProduct({
    ...reqCtx,
    params: { productId: created.id },
    body: {
      expectedVersion: 1,
      name: "Scheduled ring renamed",
      fixedPricing: { basePricePaise: 200_000, salePricePaise: 150_000 },
    },
  });
  const reloaded = await ecommerce.getProduct({
    ...reqCtx,
    params: { productId: created.id },
  });
  assert.equal(reloaded.name, "Scheduled ring renamed");
  assert.equal(isoDate(reloaded.fixedPricing.saleStartsAt), saleStart.toISOString());
  assert.equal(isoDate(reloaded.fixedPricing.saleEndsAt), saleEnd.toISOString());
});

test("name-only PATCH preserves gold-rate offer schedule instants", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
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
  const offerStart = new Date("2026-09-01T04:00:00.000Z");
  const offerEnd = new Date("2026-09-30T23:59:00.000Z");
  const created = await ecommerce.createProduct({
    ...reqCtx,
    body: {
      name: "Offer bangle",
      slug: "offer-bangle",
      priceMode: EcommercePriceMode.GOLD_RATE_BASED,
      purity: "22K",
      goldWeightMg: 8000,
      makingChargeMode: EcommerceMakingChargeMode.FIXED_PAISE,
      makingCharge: { fixedPaise: 5000 },
      offer: {
        type: EcommerceOfferType.PERCENT_OFF,
        percentBps: 1000,
        startsAt: offerStart.toISOString(),
        endsAt: offerEnd.toISOString(),
      },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.patchProduct({
    ...reqCtx,
    params: { productId: created.id },
    body: {
      expectedVersion: 1,
      name: "Offer bangle renamed",
      offer: { type: EcommerceOfferType.PERCENT_OFF, percentBps: 1000 },
    },
  });
  const reloaded = await ecommerce.getProduct({
    ...reqCtx,
    params: { productId: created.id },
  });
  assert.equal(isoDate(reloaded.offer.startsAt), offerStart.toISOString());
  assert.equal(isoDate(reloaded.offer.endsAt), offerEnd.toISOString());
});

test("PATCH can clear one sale schedule field while preserving the other", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const reqCtx = {
    auth: { tenantId: tenant._id, id: user._id, permissions: [Permission.ECOMMERCE_WRITE, Permission.ECOMMERCE_READ] },
    tenant: tenantCtx(tenant),
    scope: { tenantId: tenant._id },
  };
  await ecommerce.putTaxSettings({
    ...reqCtx,
    body: { rates: [{ code: "GST_3", rateBps: 300, active: true }], defaultClassification: "GST_3" },
  });
  const saleStart = new Date("2026-07-01T00:00:00.000Z");
  const saleEnd = new Date("2026-07-31T00:00:00.000Z");
  const created = await ecommerce.createProduct({
    ...reqCtx,
    body: {
      name: "Partial clear",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: {
        basePricePaise: 100_000,
        salePricePaise: 90_000,
        saleStartsAt: saleStart.toISOString(),
        saleEndsAt: saleEnd.toISOString(),
      },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.patchProduct({
    ...reqCtx,
    params: { productId: created.id },
    body: {
      expectedVersion: 1,
      fixedPricing: {
        basePricePaise: 100_000,
        salePricePaise: 90_000,
        saleEndsAt: null,
      },
    },
  });
  const reloaded = await ecommerce.getProduct({
    ...reqCtx,
    params: { productId: created.id },
  });
  assert.equal(isoDate(reloaded.fixedPricing.saleStartsAt), saleStart.toISOString());
  assert.equal(reloaded.fixedPricing.saleEndsAt, null);
});

test("title-only save does not clear schedules or sale price", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const reqCtx = {
    auth: { tenantId: tenant._id, id: user._id, permissions: [Permission.ECOMMERCE_WRITE, Permission.ECOMMERCE_READ] },
    tenant: tenantCtx(tenant),
    scope: { tenantId: tenant._id },
  };
  await ecommerce.putTaxSettings({
    ...reqCtx,
    body: { rates: [{ code: "GST_3", rateBps: 300, active: true }], defaultClassification: "GST_3" },
  });
  const created = await ecommerce.createProduct({
    ...reqCtx,
    body: {
      name: "Keep sale",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: {
        basePricePaise: 100_000,
        salePricePaise: 80_000,
        saleStartsAt: "2026-06-01T00:00:00.000Z",
      },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.patchProduct({
    ...reqCtx,
    params: { productId: created.id },
    body: { expectedVersion: 1, name: "Keep sale v2" },
  });
  const row = await EcommerceProduct.findById(created.id).lean();
  assert.equal(row.fixedPricing.salePricePaise, 80_000);
  assert.equal(isoDate(row.fixedPricing.saleStartsAt), "2026-06-01T00:00:00.000Z");
});

test("rejects merged sale window where start is after end", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const reqCtx = {
    auth: { tenantId: tenant._id, id: user._id, permissions: [Permission.ECOMMERCE_WRITE, Permission.ECOMMERCE_READ] },
    tenant: tenantCtx(tenant),
    scope: { tenantId: tenant._id },
  };
  await ecommerce.putTaxSettings({
    ...reqCtx,
    body: { rates: [{ code: "GST_3", rateBps: 300, active: true }], defaultClassification: "GST_3" },
  });
  const created = await ecommerce.createProduct({
    ...reqCtx,
    body: {
      name: "Bad window",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 100_000 },
      taxClassification: "GST_3",
    },
  });
  await assert.rejects(
    () =>
      ecommerce.patchProduct({
        ...reqCtx,
        params: { productId: created.id },
        body: {
          expectedVersion: 1,
          fixedPricing: {
            basePricePaise: 100_000,
            saleStartsAt: "2026-12-31T00:00:00.000Z",
            saleEndsAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    (err) => err.statusCode === 400 || err.code === "VALIDATION_FAILED",
  );
});

test("unchanged offer edit does not create offer campaign; offer change creates one", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
  const category = await EcommerceCategory.create({
    tenantId: tenant._id,
    name: "Chains",
    slug: "chains",
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
      name: "Chain",
      categoryId: category._id,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: {
        basePricePaise: 100_000,
        salePricePaise: 85_000,
        saleStartsAt: "2026-01-01T00:00:00.000Z",
      },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.publishProduct({
    ...reqCtx,
    params: { productId: draft.id },
    body: { expectedVersion: 1 },
  });
  const beforeCount = await EcommercePromotionCampaign.countDocuments({
    tenantId: tenant._id,
    productId: draft.id,
    kind: EcommercePromotionKind.OFFER,
  });
  const unchanged = await ecommerce.patchProduct({
    ...reqCtx,
    params: { productId: draft.id },
    body: {
      expectedVersion: 2,
      name: "Chain renamed",
      fixedPricing: { basePricePaise: 100_000, salePricePaise: 85_000 },
      notification: { enabled: true, kind: "OFFER" },
    },
  });
  assert.equal(unchanged.promotion?.queued, false);
  assert.equal(unchanged.promotion?.reason, "OFFER_UNCHANGED");
  const midCount = await EcommercePromotionCampaign.countDocuments({
    tenantId: tenant._id,
    productId: draft.id,
    kind: EcommercePromotionKind.OFFER,
  });
  assert.equal(midCount, beforeCount);
  const changed = await ecommerce.patchProduct({
    ...reqCtx,
    params: { productId: draft.id },
    body: {
      expectedVersion: 3,
      fixedPricing: { basePricePaise: 100_000, salePricePaise: 75_000 },
      notification: { enabled: true, kind: "OFFER" },
    },
  });
  assert.equal(changed.promotion?.intentPersisted, true);
  const afterCount = await EcommercePromotionCampaign.countDocuments({
    tenantId: tenant._id,
    productId: draft.id,
    kind: EcommercePromotionKind.OFFER,
  });
  assert.equal(afterCount, beforeCount + 1);
});

test("PATCH accepts null to clear sale schedule via HTTP", async () => {
  const { tenant, user } = await seedTenantUser({});
  await enableEcommerce(tenant);
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
  const created = await ecommerce.createProduct({
    ...reqCtx,
    body: {
      name: "HTTP clear",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: {
        basePricePaise: 50_000,
        saleStartsAt: "2026-05-01T00:00:00.000Z",
        saleEndsAt: "2026-05-02T00:00:00.000Z",
      },
      taxClassification: "GST_3",
    },
  });
  const res = await request(app)
    .patch(`/api/v1/admin/ecommerce/products/${created.id}`)
    .set({ authorization: `Bearer ${bearerFor(user, perms)}` })
    .send({
      expectedVersion: 1,
      fixedPricing: {
        basePricePaise: 50_000,
        saleStartsAt: null,
        saleEndsAt: null,
      },
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.fixedPricing.saleStartsAt, null);
  assert.equal(res.body.data.fixedPricing.saleEndsAt, null);
});
