/**
 * Publish scheme, ecommerce, and digital metals rates for tenant EVOLUXE.
 * Usage: npm run patch:evoluxe-rates
 */
import process from "node:process";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { EcommerceGoldPurity, UserStatus } from "../src/constants/enums.js";
import { DEFAULT_DIGITAL_METAL_ASSETS } from "../src/lib/digital-metals-readiness.js";
import { today } from "../src/lib/date.js";
import { attachSubscriptionCatalogPlan } from "../src/lib/subscription-plan-for-tenant.js";
import { Tenant, User } from "../src/models/index.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import * as phase2 from "../src/services/digital-metals-phase2.service.js";
import { setGoldRate } from "../src/services/tenant.service.js";

/** ₹/g 22K — scheme + digital gold buy anchor */
const SCHEME_GOLD_PAISE = 735_000;

const ECOMMERCE_RATES = {
  [EcommerceGoldPurity["18K"]]: 625_000,
  [EcommerceGoldPurity["22K"]]: 725_000,
  [EcommerceGoldPurity["24K"]]: 785_000,
};

async function buildAdminReq(tenantLean, actorUserId) {
  const withCatalog = await attachSubscriptionCatalogPlan(tenantLean);
  return {
    auth: { tenantId: tenantLean._id, id: actorUserId },
    tenant: withCatalog,
    body: {},
    query: {},
    params: {},
    headers: { "user-agent": "patch-evoluxe-rates" },
    ip: "127.0.0.1",
  };
}

async function main() {
  await connectDatabase();
  const tenant = await Tenant.findOne({ code: "EVOLUXE" }).lean();
  if (!tenant) {
    throw new Error("Tenant EVOLUXE not found — run your EVOLUXE seed first.");
  }
  const owner =
    (await User.findOne({ tenantId: tenant._id, role: "TENANT_OWNER", status: UserStatus.ACTIVE }).lean()) ??
    (await User.findOne({ tenantId: tenant._id, mobile: "9847030100", status: UserStatus.ACTIVE }).lean());
  if (!owner) {
    throw new Error("EVOLUXE owner user not found.");
  }

  const req = await buildAdminReq(tenant, owner._id);
  const effectiveDay = today();
  const nowIso = new Date().toISOString();

  const scheme = await setGoldRate({
    ...req,
    body: {
      effectiveDate: effectiveDay,
      ratePerGramPaise: SCHEME_GOLD_PAISE,
      purity: "22K",
      source: "EVOLUXE_PATCH",
    },
  });
  console.log(`Scheme 22K ${effectiveDay}: ₹${SCHEME_GOLD_PAISE / 100}/g (${scheme._id})`);

  for (const [purity, ratePerGramPaise] of Object.entries(ECOMMERCE_RATES)) {
    const row = await ecommerce.setEcommerceGoldRate({
      ...req,
      body: { purity, ratePerGramPaise, effectiveAt: nowIso },
    });
    console.log(`Ecommerce ${purity}: ₹${ratePerGramPaise / 100}/g (${row.id})`);
  }

  const silverBuy = Math.max(500, Math.round(SCHEME_GOLD_PAISE / 90));
  for (const asset of DEFAULT_DIGITAL_METAL_ASSETS) {
    const buy = asset.metal === "GOLD" ? SCHEME_GOLD_PAISE : silverBuy;
    const sell = Math.max(1, buy - (asset.metal === "GOLD" ? 800 : 80));
    const row = await phase2.publishDigitalMetalsRate({
      ...req,
      body: {
        metal: asset.metal,
        finenessPpm: asset.finenessPpm,
        customerBuyRatePerGramPaise: buy,
        customerSellRatePerGramPaise: sell,
        effectiveAt: nowIso,
      },
    });
    console.log(
      `Digital ${asset.metal}: buy ₹${buy / 100}/g sell ₹${sell / 100}/g (seq ${row.sequence})`,
    );
  }

  console.log("\nEVOLUXE rates published for scheme, online store, and digital gold & silver.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
