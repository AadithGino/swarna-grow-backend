import test from "node:test";
import assert from "node:assert/strict";
import {
  EcommercePriceMode,
  EcommerceProductStatus,
  PlanTier,
  UploadPurpose,
  UploadStatus,
} from "../src/constants/enums.js";
import { EcommerceProduct, Upload } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function entitledTenant(tenant) {
  return {
    ...tenant.toObject(),
    subscription: {
      ...tenant.subscription,
      tier: PlanTier.PRO,
      planFeaturesSnapshot: { ecommerce: true },
    },
  };
}

function reqFor(tenant, user, extra = {}) {
  return {
    auth: { tenantId: tenant._id, id: user._id },
    tenant: entitledTenant(tenant),
    body: {},
    query: {},
    params: {},
    ...extra,
  };
}

test("tenant isolation on categories", async () => {
  const a = await seedTenantUser({ tenantCode: "SHOPA" });
  const b = await seedTenantUser({ tenantCode: "SHOPB" });
  const cat = await ecommerce.createCategory(
    reqFor(a.tenant, a.user, {
      body: { name: "Rings", slug: "rings" },
    }),
  );
  await assert.rejects(
    () =>
      ecommerce.getCategory(
        reqFor(b.tenant, b.user, { params: { categoryId: cat.id } }),
      ),
    (err) => err.statusCode === 404,
  );
});

test("slug uniqueness per tenant", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "SLUG1" });
  await ecommerce.createCategory(
    reqFor(tenant, user, { body: { name: "A", slug: "same-slug" } }),
  );
  await assert.rejects(
    () =>
      ecommerce.createCategory(
        reqFor(tenant, user, { body: { name: "B", slug: "same-slug" } }),
      ),
    (err) => err.code === 11000 || err.name === "MongoServerError",
  );
});

test("downgrade blocks catalog write but keeps admin read", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "DOWN1" });
  const entitled = reqFor(tenant, user, {
    body: { name: "Chain", slug: "chain" },
  });
  const cat = await ecommerce.createCategory(entitled);
  const downgraded = {
    ...entitled,
    tenant: {
      ...entitled.tenant,
      subscription: { tier: PlanTier.STARTER, planFeaturesSnapshot: { ecommerce: false } },
    },
  };
  await assert.rejects(
    () =>
      ecommerce.createProduct({
        ...downgraded,
        body: {
          name: "Product",
          priceMode: EcommercePriceMode.FIXED,
          fixedPricing: { basePricePaise: 1000 },
        },
      }),
    (err) => err.code === "FEATURE_NOT_ENTITLED",
  );
  const read = await ecommerce.getCategory({
    ...downgraded,
    params: { categoryId: cat.id },
  });
  assert.equal(read.slug, "chain");
});

test("shop availability false when entitled but store switch off", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "SWOFF" });
  const base = reqFor(tenant, user);
  const status = await ecommerce.shopAvailability({
    ...base,
    tenant: {
      ...base.tenant,
      operations: { ecommerceEnabled: false },
    },
  });
  assert.equal(status.available, false);
  assert.equal(status.ecommerce.planEntitled, true);
  assert.equal(status.ecommerce.enabled, false);
});

test("archived category hides published products from storefront", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "CARCH" });
  const base = reqFor(tenant, user);
  await ecommerce.putTaxSettings({
    ...base,
    body: {
      rates: [{ code: "GST_3", rateBps: 300, active: true }],
      defaultClassification: "GST_3",
    },
  });
  const cat = await ecommerce.createCategory({
    ...base,
    body: { name: "Rings", slug: "rings" },
  });
  const product = await ecommerce.createProduct({
    ...base,
    body: {
      name: "Ring",
      categoryId: cat.id,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 5000 },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.publishProduct({
    ...base,
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  await ecommerce.archiveCategory({
    ...base,
    params: { categoryId: cat.id },
    body: { expectedVersion: 1 },
  });
  const onStore = {
    ...base,
    tenant: { ...base.tenant, operations: { ecommerceEnabled: true } },
  };
  const list = await ecommerce.shopListProducts(onStore);
  assert.equal(list.items.length, 0);
});

test("storefront requires operational store and published products", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "STORE1" });
  const base = reqFor(tenant, user);
  await ecommerce.putTaxSettings({
    ...base,
    body: {
      rates: [{ code: "GST_3", rateBps: 300, active: true }],
      defaultClassification: "GST_3",
    },
  });
  const product = await ecommerce.createProduct({
    ...base,
    body: {
      name: "Bangle",
      slug: "bangle",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 25_000 },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.publishProduct({
    ...base,
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  const offStore = {
    ...base,
    tenant: { ...base.tenant, operations: { ecommerceEnabled: false } },
  };
  await assert.rejects(
    () => ecommerce.shopListProducts(offStore),
    (err) => err.code === "ECOMMERCE_NOT_AVAILABLE",
  );
  const onStore = {
    ...base,
    tenant: {
      ...base.tenant,
      operations: { ecommerceEnabled: true },
    },
  };
  const list = await ecommerce.shopListProducts(onStore);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].status, EcommerceProductStatus.PUBLISHED);
});

test("upload ownership rejects other-tenant file", async () => {
  const a = await seedTenantUser({ tenantCode: "UPLA" });
  const b = await seedTenantUser({ tenantCode: "UPLB" });
  const foreign = await Upload.create({
    _id: createId("upload"),
    tenantId: b.tenant._id,
    ownerId: b.user._id,
    purpose: UploadPurpose.ECOMMERCE_PRODUCT_IMAGE,
    status: UploadStatus.UPLOADED,
    contentType: "image/png",
    fileName: "x.png",
    objectKey: "test/x.png",
  });
  await assert.rejects(
    () =>
      ecommerce.createProduct(
        reqFor(a.tenant, a.user, {
          body: {
            name: "Ring",
            priceMode: EcommercePriceMode.FIXED,
            fixedPricing: { basePricePaise: 1000 },
            imageUploadIds: [foreign._id],
          },
        }),
      ),
    (err) => err.statusCode === 404,
  );
});

test("archive product retains record", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "ARC1" });
  const base = reqFor(tenant, user);
  const product = await ecommerce.createProduct({
    ...base,
    body: {
      name: "Pendant",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 5000 },
    },
  });
  await ecommerce.archiveProduct({
    ...base,
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  const row = await EcommerceProduct.findById(product.id).lean();
  assert.equal(row.status, EcommerceProductStatus.ARCHIVED);
});
