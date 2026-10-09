import test from "node:test";
import assert from "node:assert/strict";
import {
  EcommerceMakingChargeMode,
  EcommercePriceMode,
  PlanTier,
} from "../src/constants/enums.js";
import { EcommerceProduct, EcommerceTaxSettings } from "../src/models/index.js";
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

async function seedTax(base) {
  return ecommerce.putTaxSettings({
    ...base,
    body: {
      rates: [{ code: "GST_3", label: "GST 3%", rateBps: 300, active: true }],
      defaultClassification: "GST_3",
    },
  });
}

test("patch product response matches persisted row and pricing", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "TX1" });
  const base = reqFor(tenant, user);
  await seedTax(base);
  const created = await ecommerce.createProduct({
    ...base,
    body: {
      name: "Chain",
      slug: "chain",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 10_000 },
      taxClassification: "GST_3",
    },
  });
  const patched = await ecommerce.patchProduct({
    ...base,
    params: { productId: created.id },
    body: { expectedVersion: 1, name: "Chain updated" },
  });
  const row = await EcommerceProduct.findById(created.id).lean();
  assert.equal(patched.name, "Chain updated");
  assert.equal(row.name, patched.name);
  assert.equal(patched.version, row.version);
  assert.equal(patched.pricing.computable, true);
  assert.ok(patched.pricing.displayTotal);
});

test("publish returns pricing parity", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "TX2" });
  const base = reqFor(tenant, user);
  await seedTax(base);
  const product = await ecommerce.createProduct({
    ...base,
    body: {
      name: "Bangle",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 20_000 },
      taxClassification: "GST_3",
    },
  });
  const published = await ecommerce.publishProduct({
    ...base,
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  const row = await EcommerceProduct.findById(product.id).lean();
  assert.equal(published.status, "PUBLISHED");
  assert.equal(row.status, "PUBLISHED");
  assert.equal(published.pricing.computable, true);
});

test("tax settings first save and update return matching version", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "TX3" });
  const base = reqFor(tenant, user);
  const first = await ecommerce.putTaxSettings({
    ...base,
    body: {
      rates: [{ code: "GST_3", rateBps: 300, active: true }],
      defaultClassification: "GST_3",
    },
  });
  const doc = await EcommerceTaxSettings.findOne({ tenantId: tenant._id }).lean();
  assert.equal(first.version, doc.version);
  const second = await ecommerce.putTaxSettings({
    ...base,
    body: {
      expectedVersion: first.version,
      rates: [{ code: "GST_3", rateBps: 300, active: true }],
      defaultClassification: null,
    },
  });
  assert.equal(second.defaultClassification, null);
  const doc2 = await EcommerceTaxSettings.findOne({ tenantId: tenant._id }).lean();
  assert.equal(second.version, doc2.version);
});

test("tax settings update rejects duplicate rate codes", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "TX4" });
  const base = reqFor(tenant, user);
  const first = await ecommerce.putTaxSettings({
    ...base,
    body: { rates: [{ code: "GST_3", rateBps: 300, active: true }] },
  });
  await assert.rejects(
    () =>
      ecommerce.putTaxSettings({
        ...base,
        body: {
          expectedVersion: first.version,
          rates: [
            { code: "GST_3", rateBps: 300, active: true },
            { code: "GST_3", rateBps: 500, active: true },
          ],
        },
      }),
    (err) => err.statusCode === 400 || err.code === "VALIDATION_FAILED",
  );
});

test("tax settings version conflict", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "TX5" });
  const base = reqFor(tenant, user);
  const first = await ecommerce.putTaxSettings({
    ...base,
    body: { rates: [{ code: "GST_3", rateBps: 300, active: true }] },
  });
  await assert.rejects(
    () =>
      ecommerce.putTaxSettings({
        ...base,
        body: {
          expectedVersion: first.version - 1,
          rates: [{ code: "GST_3", rateBps: 300, active: true }],
        },
      }),
    (err) => err.code === "VERSION_CONFLICT",
  );
});

test("publish blocked when dynamic pricing not computable", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "TX6" });
  const base = reqFor(tenant, user);
  await seedTax(base);
  const product = await ecommerce.createProduct({
    ...base,
    body: {
      name: "Necklace",
      priceMode: EcommercePriceMode.GOLD_RATE_BASED,
      purity: "22K",
      goldWeightMg: 5000,
      makingChargeMode: EcommerceMakingChargeMode.FIXED_PAISE,
      makingCharge: { fixedPaise: 1000 },
      taxClassification: "GST_3",
    },
  });
  await assert.rejects(
    () =>
      ecommerce.publishProduct({
        ...base,
        params: { productId: product.id },
        body: { expectedVersion: 1 },
      }),
    (err) => err.statusCode === 400 || err.code === "VALIDATION_FAILED",
  );
});

test("shop list omits display total when tax config no longer matches product", async () => {
  const { tenant, user } = await seedTenantUser({ tenantCode: "TX7" });
  const base = reqFor(tenant, user);
  const tax = await seedTax(base);
  const product = await ecommerce.createProduct({
    ...base,
    body: {
      name: "Bracelet",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 15_000 },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.publishProduct({
    ...base,
    params: { productId: product.id },
    body: { expectedVersion: 1 },
  });
  await ecommerce.putTaxSettings({
    ...base,
    body: {
      expectedVersion: tax.version,
      rates: [{ code: "GST_5", rateBps: 500, active: true }],
      defaultClassification: "GST_5",
    },
  });
  const onStore = {
    ...base,
    tenant: { ...base.tenant, operations: { ecommerceEnabled: true } },
  };
  const list = await ecommerce.shopListProducts(onStore);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].pricing.computable, false);
  assert.equal(list.items[0].pricing.displayTotal, null);
});
