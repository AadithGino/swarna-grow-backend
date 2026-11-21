/**
 * MYDREAM ecommerce: branch pickup (all branches) + delivery (all India pincodes) + checkout tax fixture.
 *
 *   npm run patch:mydream-ecommerce-fulfilment
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { TenantRole, UserStatus } from "../src/constants/enums.js";
import { attachSubscriptionCatalogPlan } from "../src/lib/subscription-plan-for-tenant.js";
import { mapCheckoutReadiness } from "../src/lib/ecommerce-checkout-tax.js";
import { deriveDeliveryConfigured, mapFulfilmentSettings } from "../src/lib/ecommerce-fulfilment.js";
import { Branch, Tenant, User } from "../src/models/index.js";
import * as adminCommerce from "../src/services/ecommerce-admin-commerce.service.js";
import { loadTaxSettings } from "../src/services/ecommerce.service.js";
import { demoCheckoutTaxConfigBody } from "./lib/ecommerce-demo-checkout.js";
import { DEMO_TAX_CLASSIFICATION, ensureDemoDisplayTaxSettings } from "./lib/ecommerce-demo-tax.js";
import { INDIA_DESTINATION_STATES } from "./lib/india-states.js";

const TENANT_CODE = "MYDREAM";

async function buildAdminReq(tenant, ownerId) {
  const withCatalog = await attachSubscriptionCatalogPlan(tenant);
  return {
    auth: { tenantId: tenant._id, id: ownerId },
    tenant: withCatalog,
    body: {},
    query: {},
    params: {},
    headers: { "user-agent": "patch-mydream-ecommerce-fulfilment" },
    ip: "127.0.0.1",
  };
}

async function main() {
  await connectDatabase();
  const tenant = await Tenant.findOne({ code: TENANT_CODE });
  if (!tenant) throw new Error(`Tenant ${TENANT_CODE} not found`);

  const owner = await User.findOne({
    tenantId: tenant._id,
    role: TenantRole.TENANT_OWNER,
    status: UserStatus.ACTIVE,
  }).lean();
  if (!owner) throw new Error("Owner missing");

  const req = await buildAdminReq(tenant.toObject(), owner._id);
  const report = { tax: null, checkout: null, fulfilment: null };

  const taxClassification =
    (await ensureDemoDisplayTaxSettings(req, false, report)) ?? DEMO_TAX_CLASSIFICATION;

  const branches = await Branch.find({ tenantId: tenant._id, active: { $ne: false } })
    .select("_id code name isHeadOffice")
    .lean();
  if (!branches.length) throw new Error("No active branches");

  const existing = await adminCommerce.getAdminFulfilmentSettings(req);
  const checkoutTaxConfig = {
    ...demoCheckoutTaxConfigBody({
      itemClassification: taxClassification,
      registeredState: tenant.address?.state ?? "Kerala",
      extraDestinationStates: INDIA_DESTINATION_STATES.filter(
        (s) => s !== (tenant.address?.state ?? "Kerala"),
      ),
    }),
    supportedDestinationStates: INDIA_DESTINATION_STATES,
    deliveryAllPincodes: true,
  };

  const updated = await adminCommerce.putAdminFulfilmentSettings({
    ...req,
    body: {
      expectedVersion: existing.version ?? 1,
      pickupEnabled: true,
      pickupBranchIds: branches.map((b) => b._id),
      deliveryEnabled: true,
      deliveryChargePaise: 0,
      serviceablePincodes: [],
      schemeCheckoutEnabled: true,
      checkoutTaxConfig,
    },
  });

  const taxSettings = await loadTaxSettings(tenant._id);
  const mapped = mapFulfilmentSettings(updated);
  const readiness = mapCheckoutReadiness(taxSettings, updated);

  console.log(
    JSON.stringify(
      {
        tenant: TENANT_CODE,
        branches: branches.map((b) => ({ id: b._id, code: b.code, name: b.name })),
        pickupEnabled: mapped.pickupEnabled,
        pickupBranchCount: mapped.pickupBranchIds.length,
        deliveryEnabled: mapped.deliveryEnabled,
        deliveryConfigured: deriveDeliveryConfigured(updated),
        deliveryAllPincodes: mapped.deliveryAllPincodes,
        deliveryChargePaise: mapped.deliveryChargePaise,
        checkoutReady: readiness.ready,
        checkoutBlockers: readiness.blockers,
      },
      null,
      2,
    ),
  );

  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});