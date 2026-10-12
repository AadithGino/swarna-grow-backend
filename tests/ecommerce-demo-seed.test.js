import test from "node:test";
import assert from "node:assert/strict";
import {
  EcommerceCategory,
  EcommerceGoldRate,
  EcommerceProduct,
  Tenant,
} from "../src/models/index.js";
import {
  demoSlugPrefix,
  isDemoOwnedSlug,
  runEcommerceDemoSeed,
} from "../scripts/lib/ecommerce-demo-seed.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

async function seedEntitledTenant(tenantCode) {
  const base = await seedTenantUser({ tenantCode });
  await Tenant.updateOne(
    { _id: base.tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot": { ecommerce: true },
        "operations.ecommerceEnabled": true,
      },
    },
  );
  const fresh = await Tenant.findById(base.tenant._id);
  return { ...base, tenant: fresh };
}

test("demo slug prefix is tenant-scoped", () => {
  assert.equal(isDemoOwnedSlug("demo-ec-meher-ring", "MEHER"), true);
  assert.equal(isDemoOwnedSlug("demo-ec-kairali-ring", "MEHER"), false);
  assert.ok(demoSlugPrefix("KAIRALI").startsWith("demo-ec-kairali-"));
});

test("runEcommerceDemoSeed is idempotent per tenant", async () => {
  await seedEntitledTenant("MEHER");
  await seedEntitledTenant("KAIRALI");

  const first = await runEcommerceDemoSeed({
    tenantCodes: ["MEHER", "KAIRALI"],
    dryRun: false,
  });
  assert.equal(first.errors.length, 0);

  const meherId = first.tenants.find((t) => t.tenantCode === "MEHER")?.tenantId;
  const counts1 = {
    categories: await EcommerceCategory.countDocuments({ tenantId: meherId, slug: { $regex: "^demo-ec-meher-" } }),
    products: await EcommerceProduct.countDocuments({ tenantId: meherId, slug: { $regex: "^demo-ec-meher-" } }),
    seedRates: await EcommerceGoldRate.countDocuments({ tenantId: meherId, enteredBy: "seed-ecommerce-demo" }),
  };
  assert.ok(counts1.categories >= 4);
  assert.ok(counts1.products >= 8);
  const meherAcceptance = first.tenants.find((t) => t.tenantCode === "MEHER")?.acceptance;
  assert.ok((meherAcceptance?.products?.published ?? 0) >= 6, "expected >=6 published demo products for MEHER");
  assert.ok((meherAcceptance?.products?.computable ?? 0) >= 6, "expected computable published demo prices");
  const meherCheckout = first.tenants.find((t) => t.tenantCode === "MEHER")?.checkoutTax;
  assert.equal(meherCheckout?.checkoutTaxReady, true, "demo checkout fixture should pass readiness in test DB");
  const meherDelivery = first.tenants.find((t) => t.tenantCode === "MEHER")?.delivery;
  assert.equal(meherDelivery?.deliveryEnabled, true);
  assert.equal(meherDelivery?.deliveryChargePaise, 0);

  const second = await runEcommerceDemoSeed({
    tenantCodes: ["MEHER", "KAIRALI"],
    dryRun: false,
  });
  const counts2 = {
    categories: await EcommerceCategory.countDocuments({ tenantId: meherId, slug: { $regex: "^demo-ec-meher-" } }),
    products: await EcommerceProduct.countDocuments({ tenantId: meherId, slug: { $regex: "^demo-ec-meher-" } }),
    seedRates: await EcommerceGoldRate.countDocuments({ tenantId: meherId, enteredBy: "seed-ecommerce-demo" }),
  };
  assert.deepEqual(counts2, counts1);
  assert.equal(
    second.tenants.find((t) => t.tenantCode === "MEHER")?.afterCounts?.products,
    first.tenants.find((t) => t.tenantCode === "MEHER")?.afterCounts?.products,
  );
});

test("tenant isolation: demo products stay scoped", async () => {
  await seedEntitledTenant("MEHER");
  const b = await seedEntitledTenant("KAIRALI");
  await runEcommerceDemoSeed({ tenantCodes: ["MEHER"], dryRun: false });
  const cross = await EcommerceProduct.countDocuments({
    tenantId: b.tenant._id,
    slug: { $regex: "^demo-ec-meher-" },
  });
  assert.equal(cross, 0);
});

test("store-off tenant skips storefront preview but can still seed catalog when entitled", async () => {
  const { tenant } = await seedEntitledTenant("MEHER");
  await Tenant.updateOne({ _id: tenant._id }, { $set: { "operations.ecommerceEnabled": false } });
  const summary = await runEcommerceDemoSeed({ tenantCodes: ["MEHER"], dryRun: false });
  const row = summary.tenants[0];
  assert.equal(row.entitlement.storeOperational, false);
  assert.ok(row.afterCounts.products >= 8);
  assert.equal(row.storefrontPreview?.blocked, true);
});

test("missing tenant code returns error without throwing", async () => {
  const summary = await runEcommerceDemoSeed({ tenantCodes: ["NOTREAL"], dryRun: true });
  assert.equal(summary.errors[0]?.code, "NOTREAL");
  assert.equal(summary.errors[0]?.error, "TENANT_NOT_FOUND");
});
