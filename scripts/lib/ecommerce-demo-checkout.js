import { EcommerceCheckoutTaxPresentation } from "../../src/constants/enums.js";
import { evaluateCheckoutTaxReadiness } from "../../src/lib/ecommerce-checkout-tax.js";
import { loadTaxSettings } from "../../src/services/ecommerce.service.js";
import * as adminCommerce from "../../src/services/ecommerce-admin-commerce.service.js";
import { isDemoOnlyTaxSettings } from "./ecommerce-demo-tax.js";

export const DEMO_CHECKOUT_SIGN_OFF = "TEST-DEMO-ECOMMERCE-ONLY-NOT-PRODUCTION";
export const DEMO_CHECKOUT_SELLER_NAME =
  "TEST DATA — Demo jeweller (non-production checkout fixture)";

/** Valid 15-char GSTIN shape for readiness checks only — not a real taxpayer. */
export const DEMO_CHECKOUT_GSTIN = "32ABCDE1234F1Z5";

export function isDemoCheckoutFixtureConfig(checkoutTaxConfig) {
  const ref = String(checkoutTaxConfig?.accountantSignOffReference ?? "");
  const name = String(checkoutTaxConfig?.sellerLegalName ?? "");
  return (
    ref.includes("TEST-DEMO")
    || ref.includes("TEST DATA")
    || name.includes("TEST DATA")
  );
}

export function shouldApplyDemoCheckoutFixture(taxSettings, fulfilmentRow) {
  if (!isDemoOnlyTaxSettings(taxSettings)) return false;
  const cfg = fulfilmentRow?.checkoutTaxConfig ?? {};
  const presentation = cfg.presentation ?? EcommerceCheckoutTaxPresentation.UNCONFIGURED;
  if (
    presentation === EcommerceCheckoutTaxPresentation.ACCOUNTANT_COMPONENT_APPROVED
    && !isDemoCheckoutFixtureConfig(cfg)
  ) {
    const readiness = evaluateCheckoutTaxReadiness(taxSettings, fulfilmentRow ?? {});
    if (readiness.ready) return false;
    return true;
  }
  return true;
}

export function demoCheckoutTaxConfigBody({
  itemClassification,
  registeredState = "Kerala",
  extraDestinationStates = ["Karnataka"],
} = {}) {
  const intraLines = [
    { componentKey: "CGST", label: "CGST (TEST DATA fixture)", rateBps: 150 },
    { componentKey: "SGST", label: "SGST (TEST DATA fixture)", rateBps: 150 },
  ];
  const interLines = [
    { componentKey: "IGST", label: "IGST (TEST DATA fixture)", rateBps: 300 },
  ];
  const destinations = [
    registeredState,
    ...extraDestinationStates.filter((s) => s && s !== registeredState),
  ];
  return {
    presentation: EcommerceCheckoutTaxPresentation.ACCOUNTANT_COMPONENT_APPROVED,
    sellerLegalName: DEMO_CHECKOUT_SELLER_NAME,
    sellerGstin: DEMO_CHECKOUT_GSTIN,
    registeredState,
    defaultPlaceOfSupplyState: registeredState,
    defaultItemTaxClassification: itemClassification,
    accountantSignOffReference: DEMO_CHECKOUT_SIGN_OFF,
    accountantApprovedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    componentLines: intraLines,
    componentRules: [
      { supplyCase: "INTRA_STATE", componentLines: intraLines },
      { supplyCase: "INTER_STATE", componentLines: interLines },
    ],
    supportedDestinationStates: destinations,
  };
}

export async function ensureDemoCheckoutTaxConfig(req, {
  dryRun,
  report,
  itemClassification,
  registeredState = "Kerala",
} = {}) {
  const taxSettings = (await loadTaxSettings(req.auth.tenantId)) ?? { rates: [] };
  const existing = await adminCommerce.getAdminFulfilmentSettings(req);
  if (!shouldApplyDemoCheckoutFixture(taxSettings, existing)) {
    report.checkoutTax = {
      action: "preserved_existing",
      note: "Non-demo catalog tax or accountant checkout config present; not modified.",
    };
    return existing;
  }
  const classification =
    itemClassification
    ?? taxSettings.defaultClassification
    ?? null;
  if (!classification) {
    report.checkoutTax = {
      action: "skipped_no_classification",
      note: "Configure display tax before demo checkout fixture.",
    };
    return existing;
  }
  const checkoutTaxConfig = demoCheckoutTaxConfigBody({
    itemClassification: classification,
    registeredState,
  });
  if (dryRun) {
    report.checkoutTax = {
      action: "would_upsert_demo_checkout_fixture",
      classification,
      signOff: DEMO_CHECKOUT_SIGN_OFF,
    };
    return existing;
  }
  const saved = await adminCommerce.putAdminFulfilmentSettings({
    ...req,
    body: {
      expectedVersion: existing.version ?? 1,
      checkoutTaxConfig,
    },
  });
  const readiness = evaluateCheckoutTaxReadiness(
    taxSettings,
    { checkoutTaxConfig: saved.checkoutTaxConfig ?? checkoutTaxConfig },
  );
  report.checkoutTax = {
    action: "upserted_demo_checkout_fixture",
    classification,
    checkoutTaxReady: readiness.ready,
    blockers: readiness.blockers,
    signOff: DEMO_CHECKOUT_SIGN_OFF,
  };
  return saved;
}
