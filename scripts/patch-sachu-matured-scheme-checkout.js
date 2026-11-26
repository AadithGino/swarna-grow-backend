/**
 * KAIRALI · customer 7907753163 — matured cash + gold schemes for online shop checkout.
 *
 * Also enables scheme checkout, plan purchase rules, product eligibility, and a 22K
 * gold-rate product for GOLD_WEIGHT settlement tests.
 *
 *   npm run patch:sachu-matured-scheme-checkout
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  EcommerceGoldPurity,
  EcommerceMakingChargeMode,
  EcommercePriceMode,
  EcommerceProductStatus,
  EcommerceStockPolicy,
  PaymentStatus,
  TenantRole,
  UserStatus,
  UserType,
} from "../src/constants/enums.js";
import { attachSubscriptionCatalogPlan } from "../src/lib/subscription-plan-for-tenant.js";
import dayjs from "dayjs";
import { addMonthsClamped, today } from "../src/lib/date.js";
import { createId } from "../src/lib/ids.js";
import {
  Branch,
  Customer,
  EcommerceCategory,
  EcommerceFulfilmentSettings,
  EcommerceGoldRate,
  EcommerceInventory,
  EcommerceProduct,
  GoldRate,
  Payment,
  Redemption,
  Scheme,
  SchemePlan,
  Tenant,
  User,
} from "../src/models/index.js";
import * as adminCommerce from "../src/services/ecommerce-admin-commerce.service.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import { markMatured, payInstallments, seedMatureFixedGold } from "./seed-aira-gold-matrix.js";

const TENANT_CODE = "KAIRALI";
const CUSTOMER_MOBILE = "7907753163";
const DEMO_GOLD_PRODUCT_SLUG = "kairali-scheme-checkout-22k-bangle";

const SCHEME_PURCHASE_CASH = {
  channel: "ONLINE",
  settlementBases: ["CASH_VALUE"],
  makingChargeWaiver: { kind: "FULL" },
};

const SCHEME_PURCHASE_GOLD = {
  channel: "ONLINE",
  settlementBases: ["GOLD_WEIGHT"],
  makingChargeWaiver: { kind: "FULL" },
};

function adminCtx(tenant, owner) {
  return {
    auth: {
      id: owner._id,
      tenantId: tenant._id,
      type: UserType.TENANT_USER,
      role: TenantRole.TENANT_OWNER,
    },
    scope: { tenantId: tenant._id },
    tenant,
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "patch-sachu-matured-scheme-checkout" },
    ip: "127.0.0.1",
    body: {},
    query: {},
  };
}

async function patchPlan(plan, rules) {
  const next = {
    ...plan.toObject(),
    schemePurchaseRules: rules,
    version: (plan.version ?? 1) + 1,
  };
  plan.schemePurchaseRules = rules;
  plan.version = next.version;
  plan.markModified("schemePurchaseRules");
  await plan.save();
  return plan;
}

async function ensureCheckoutFlags(tenantId) {
  await EcommerceCategory.updateMany({ tenantId }, { $set: { schemePurchaseAllowed: true } });
  await EcommerceProduct.updateMany(
    { tenantId, status: EcommerceProductStatus.PUBLISHED },
    { $set: { schemePurchasePolicy: "ALLOW" } },
  );
}

async function ensureSchemeGoldRatesForBackfill(tenantId, ownerId, startDate, months = 16) {
  const baseRate =
    (await GoldRate.findOne({ tenantId, purity: "22K" }).sort({ effectiveDate: -1 }).lean())
      ?.ratePerGramPaise ?? 725_000;
  const from = dayjs(startDate).startOf("month");
  const dates = new Set([today()]);
  for (let i = 0; i < months; i += 1) {
    dates.add(from.add(i, "month").format("YYYY-MM-DD"));
  }
  for (const effectiveDate of dates) {
    const exists = await GoldRate.exists({ tenantId, purity: "22K", effectiveDate });
    if (exists) continue;
    await GoldRate.create({
      _id: createId("grt"),
      tenantId,
      branchId: null,
      ratePerGramPaise: baseRate,
      effectiveDate,
      purity: "22K",
      enteredBy: ownerId,
    });
  }
}

async function ensureEcommerceGoldRate(ctx, tenantId, ownerId) {
  const latestScheme = await GoldRate.findOne({ tenantId, purity: "22K" })
    .sort({ effectiveDate: -1 })
    .lean();
  const ratePerGramPaise = latestScheme?.ratePerGramPaise ?? 725_000;
  const existing = await EcommerceGoldRate.findOne({
    tenantId,
    purity: EcommerceGoldPurity["22K"],
  })
    .sort({ effectiveAt: -1 })
    .lean();
  if (existing?.ratePerGramPaise) return existing;
  return ecommerce.setEcommerceGoldRate({
    ...ctx,
    body: { purity: EcommerceGoldPurity["22K"], ratePerGramPaise },
  });
}

async function ensureGoldRateProduct(ctx, tenantId, categoryId) {
  let row = await EcommerceProduct.findOne({ tenantId, slug: DEMO_GOLD_PRODUCT_SLUG });
  if (!row) {
    row = await EcommerceProduct.create({
      _id: createId("eprd"),
      tenantId,
      slug: DEMO_GOLD_PRODUCT_SLUG,
      sku: "KJR-SCH-DEMO-22K",
      name: "22K Demo Bangle (scheme gold test)",
      description: "Lightweight 22K bangle for matured GOLD11 shop checkout QA.",
      categoryId,
      status: EcommerceProductStatus.PUBLISHED,
      featured: false,
      priceMode: EcommercePriceMode.GOLD_RATE_BASED,
      purity: EcommerceGoldPurity["22K"],
      goldWeightMg: 5200,
      makingChargeMode: EcommerceMakingChargeMode.FIXED_PAISE,
      makingCharge: { fixedPaise: 12_000_00 },
      schemePurchasePolicy: "ALLOW",
      taxClassification: "JEWELLERY_22K",
      version: 1,
    });
    await EcommerceInventory.create({
      _id: createId("einv"),
      tenantId,
      productId: row._id,
      stockPolicy: EcommerceStockPolicy.MADE_TO_ORDER,
    });
  } else {
    await EcommerceProduct.updateOne(
      { _id: row._id },
      {
        $set: {
          status: EcommerceProductStatus.PUBLISHED,
          schemePurchasePolicy: "ALLOW",
          priceMode: EcommercePriceMode.GOLD_RATE_BASED,
          purity: EcommerceGoldPurity["22K"],
          goldWeightMg: 5200,
          makingChargeMode: EcommerceMakingChargeMode.FIXED_PAISE,
          makingCharge: { fixedPaise: 12_000_00 },
        },
      },
    );
    row = await EcommerceProduct.findById(row._id);
  }
  return row;
}

async function ensureSchemeCheckoutEnabled(req) {
  const existing = await adminCommerce.getAdminFulfilmentSettings(req);
  if (existing.schemeCheckoutEnabled === true) return existing;
  const body = {
    expectedVersion: existing.version ?? 1,
    pickupEnabled: existing.pickupEnabled ?? true,
    pickupBranchIds: existing.pickupBranchIds ?? [],
    deliveryEnabled: existing.deliveryEnabled ?? false,
    deliveryChargePaise: existing.deliveryChargePaise ?? 0,
    serviceablePincodes: existing.serviceablePincodes ?? [],
    schemeCheckoutEnabled: true,
    checkoutTaxConfig: existing.checkoutTaxConfig,
    storePolicies: existing.storePolicies,
  };
  return adminCommerce.putAdminFulfilmentSettings({ ...req, body });
}

const RESUME_EXCLUDE_ENROLLMENTS = new Set(["ENR-0000001"]);

async function findOrCreateMatured(ctx, { customer, plan, branchId }) {
  const need = plan.installmentCount ?? plan.durationMonths ?? 12;
  const startDate = addMonthsClamped(today(), -14).format("YYYY-MM-DD");
  const installmentAmountPaise = plan.amountRules?.fixedAmountPaise ?? 500_000;

  const matured = await Scheme.findOne({
    tenantId: ctx.auth.tenantId,
    customerId: customer._id,
    planId: plan._id,
    status: "MATURED",
  });
  if (matured) {
    const busy = await Redemption.exists({
      tenantId: ctx.auth.tenantId,
      schemeId: matured._id,
      status: { $in: ["REQUESTED", "APPROVED", "PENDING_HANDOVER"] },
    });
    if (!busy) {
      const rules = plan.schemePurchaseRules;
      if (rules && matured.planSnapshot?.schemePurchaseRules?.channel !== rules.channel) {
        matured.planSnapshot = { ...matured.planSnapshot, ...plan.toObject() };
        matured.markModified("planSnapshot");
        await matured.save();
      }
      return matured;
    }
  }

  const draft = await Scheme.findOne({
    tenantId: ctx.auth.tenantId,
    customerId: customer._id,
    planId: plan._id,
    status: { $in: ["ACTIVE", "LOCKED"] },
    enrollmentNumber: { $nin: [...RESUME_EXCLUDE_ENROLLMENTS] },
  });
  if (draft) {
    const paid = await Payment.countDocuments({
      schemeId: draft._id,
      status: PaymentStatus.SUCCESS,
    });
    if (plan.valueBasis === "GOLD_WEIGHT") {
      await ensureSchemeGoldRatesForBackfill(ctx.auth.tenantId, ctx.auth.id, startDate);
    }
    if (paid >= need) {
      await markMatured(draft._id);
      return Scheme.findById(draft._id);
    }
    if (paid < need) {
      await payInstallments(ctx, draft, need - paid, {
        backdateFrom: draft.startDate ?? startDate,
        amountPaise: installmentAmountPaise,
      });
      await markMatured(draft._id);
      const finished = await Scheme.findById(draft._id);
      finished.planSnapshot = { ...finished.planSnapshot, ...plan.toObject() };
      finished.markModified("planSnapshot");
      await finished.save();
      return finished;
    }
  }

  if (plan.valueBasis === "GOLD_WEIGHT") {
    await ensureSchemeGoldRatesForBackfill(ctx.auth.tenantId, ctx.auth.id, startDate);
  }
  const scheme = await seedMatureFixedGold(ctx, {
    customer,
    plan,
    branchId,
    startDate,
    installmentAmountPaise,
  });
  return scheme;
}

async function main() {
  await connectDatabase();

  const tenant = await Tenant.findOne({ code: TENANT_CODE });
  if (!tenant) throw new Error(`Tenant ${TENANT_CODE} not found — run npm run seed:demo`);

  const owner = await User.findOne({
    tenantId: tenant._id,
    role: TenantRole.TENANT_OWNER,
    status: UserStatus.ACTIVE,
  });
  if (!owner) throw new Error("Owner user missing");

  const customer = await Customer.findOne({ tenantId: tenant._id, mobile: CUSTOMER_MOBILE });
  if (!customer) {
    throw new Error(`Customer ${CUSTOMER_MOBILE} not found on ${TENANT_CODE}`);
  }

  const branch =
    (await Branch.findOne({ _id: customer.branchId, active: { $ne: false } })) ??
    (await Branch.findOne({ tenantId: tenant._id, code: "MGR", active: { $ne: false } }));
  if (!branch) throw new Error("Branch missing");

  const tenantWithCatalog = await attachSubscriptionCatalogPlan(tenant.toObject());
  const ctx = adminCtx(tenantWithCatalog, owner);

  const cashPlan = await SchemePlan.findOne({ tenantId: tenant._id, code: "SAVING11", status: "ACTIVE" });
  const goldPlan = await SchemePlan.findOne({ tenantId: tenant._id, code: "GOLD11", status: "ACTIVE" });
  if (!cashPlan || !goldPlan) throw new Error("SAVING11 / GOLD11 plans missing");

  await patchPlan(cashPlan, SCHEME_PURCHASE_CASH);
  await patchPlan(goldPlan, SCHEME_PURCHASE_GOLD);

  await ensureCheckoutFlags(tenant._id);
  await ensureEcommerceGoldRate(ctx, tenant._id, owner._id);

  const category =
    (await EcommerceCategory.findOne({ tenantId: tenant._id, name: "Bangles" })) ??
    (await EcommerceCategory.findOne({ tenantId: tenant._id, active: { $ne: false } }));
  const goldProduct = category ? await ensureGoldRateProduct(ctx, tenant._id, category._id) : null;

  await ensureSchemeCheckoutEnabled(ctx);

  const cashPlanDoc = await SchemePlan.findById(cashPlan._id);
  const goldPlanDoc = await SchemePlan.findById(goldPlan._id);
  const cashScheme = await findOrCreateMatured(ctx, {
    customer,
    plan: cashPlanDoc,
    branchId: branch._id,
  });
  const goldScheme = await findOrCreateMatured(ctx, {
    customer,
    plan: goldPlanDoc,
    branchId: branch._id,
  });

  console.log("\n=== Matured scheme checkout — Sachu / 7907753163 ===\n");
  console.log(`Customer: ${customer.name} · ${customer.mobile} · ${customer.passbookNumber ?? customer.customerNumber}`);
  console.log("\nSchemes (Shop → checkout → Apply scheme):");
  console.log(`  · CASH  ${cashScheme.enrollmentNumber} · ${cashPlan.displayName ?? cashPlan.code} · status ${cashScheme.status}`);
  console.log(`  · GOLD  ${goldScheme.enrollmentNumber} · ${goldPlan.displayName ?? goldPlan.code} · status ${goldScheme.status}`);
  console.log("\nWhat to buy:");
  console.log("  · Cash scheme (CASH_VALUE): Layered Leaf Earrings — slug kairali-jewel-leaf-earrings");
  console.log("    (~₹39k; scheme balance ~₹65k after 11+1 — full cover, no top-up).");
  console.log("  · Cash partial top-up: Mesh Weave Choker — kairali-jewel-mesh-choker (~₹98.5k).");
  console.log(`  · Gold scheme (GOLD_WEIGHT): ${goldProduct?.name ?? "22K demo bangle"} — slug ${DEMO_GOLD_PRODUCT_SLUG}`);
  console.log("    (22K rate-based ~5.2g + making; settlement uses accumulated gold weight).");
  console.log("\nLogin: /customer/kairali · OTP 123456\n");

  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase();
  process.exit(1);
});