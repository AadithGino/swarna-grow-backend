import test from "node:test";
import assert from "node:assert/strict";
import { EcommercePriceMode, PlanTier } from "../src/constants/enums.js";
import { EcommerceProduct } from "../src/models/index.js";
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
    operations: { ecommerceEnabled: true },
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

async function seedShopBasics(base) {
  await ecommerce.putTaxSettings({
    ...base,
    body: {
      rates: [{ code: "GST_3", rateBps: 300, active: true }],
      defaultClassification: "GST_3",
    },
  });
}

async function publishFixed(base, { name, categoryId = null }) {
  const product = await ecommerce.createProduct({
    ...base,
    body: {
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
      categoryId,
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 10_000 },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.publishProduct({
    ...base,
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  return product;
}

test("shop pagination keeps storefront visibility on page 2", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "PG1" });
  const base = reqFor(tenant, user);
  await seedShopBasics(base);
  const visibleCat = await ecommerce.createCategory({
    ...base,
    body: { name: "Visible", slug: "visible" },
  });
  const hiddenCat = await ecommerce.createCategory({
    ...base,
    body: { name: "Hidden", slug: "hidden" },
  });
  for (let i = 1; i <= 5; i += 1) {
    await publishFixed(base, { name: `Visible Item ${i}`, categoryId: visibleCat.id });
    await EcommerceProduct.updateOne(
      { tenantId: tenant._id, name: `Visible Item ${i}` },
      { $set: { updatedAt: new Date(Date.now() - i * 1000) } },
    );
  }
  const hiddenProduct = await publishFixed(base, {
    name: "Hidden In Archived Category",
    categoryId: hiddenCat.id,
  });
  await EcommerceProduct.updateOne(
    { _id: hiddenProduct.id },
    { $set: { updatedAt: new Date(Date.now() + 120_000) } },
  );
  await ecommerce.archiveCategory({
    ...base,
    params: { categoryId: hiddenCat.id },
    body: { expectedVersion: 1 },
  });
  const onStore = {
    ...base,
    tenant: { ...base.tenant, operations: { ecommerceEnabled: true } },
  };
  const page1 = await ecommerce.shopListProducts({ ...onStore, query: { limit: 2 } });
  assert.equal(page1.items.length, 2);
  assert.ok(page1.meta.hasMore);
  const collected = [...page1.items];
  let cursor = page1.meta.nextCursor;
  let guard = 0;
  while (page1.meta.hasMore && cursor && guard < 10) {
    guard += 1;
    const next = await ecommerce.shopListProducts({
      ...onStore,
      query: { limit: 2, cursor },
    });
    collected.push(...next.items);
    cursor = next.meta.nextCursor;
    if (!next.meta.hasMore) break;
  }
  const allIds = collected.map((row) => row.id);
  assert.equal(allIds.includes(hiddenProduct.id), false);
  assert.equal(allIds.length, 5);
  const filtered = await ecommerce.shopListProducts({
    ...onStore,
    query: { limit: 10, categoryId: visibleCat.id },
  });
  assert.equal(filtered.items.length, 5);
  await assert.rejects(
    () =>
      ecommerce.shopGetProduct({
        ...onStore,
        params: { productIdOrSlug: hiddenProduct.slug },
      }),
    (err) => err.statusCode === 404,
  );
});
