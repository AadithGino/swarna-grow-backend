import { EcommerceHsnSacType } from "../../src/constants/enums.js";
import { loadTaxSettings } from "../../src/services/ecommerce.service.js";
import * as ecommerce from "../../src/services/ecommerce.service.js";

export const DEMO_TAX_CLASSIFICATION = "DEMO_GST_3";
export const DEMO_TAX_TAG = "swarnagrow-ecommerce-demo-tax";

export function isDemoOnlyTaxSettings(taxSettings) {
  const rates = taxSettings?.rates ?? [];
  if (!rates.length) return true;
  const demoRates = rates.every((r) => String(r.code).startsWith("DEMO_"));
  const dc = taxSettings?.defaultClassification;
  const demoDefault = !dc || String(dc).startsWith("DEMO_");
  return demoRates && demoDefault;
}

export function demoDisplayTaxBody(expectedVersion) {
  return {
    expectedVersion: expectedVersion ?? 1,
    defaultClassification: DEMO_TAX_CLASSIFICATION,
    rates: [
      {
        code: DEMO_TAX_CLASSIFICATION,
        label: "Demo GST 3% (display fixture — not accountant sign-off)",
        rateBps: 300,
        active: true,
      },
    ],
    hsnSacMappings: [
      {
        classification: DEMO_TAX_CLASSIFICATION,
        hsnSacCode: "7113",
        hsnSacType: EcommerceHsnSacType.HSN,
      },
    ],
  };
}

export async function ensureDemoDisplayTaxSettings(req, dryRun, report) {
  const current = (await loadTaxSettings(req.auth.tenantId)) ?? { rates: [], version: 1 };
  if ((current.rates ?? []).some((r) => r.active !== false) && !isDemoOnlyTaxSettings(current)) {
    report.tax = {
      action: "preserved_existing",
      defaultClassification: current.defaultClassification,
      note: "Tenant has non-demo tax configuration; left unchanged.",
    };
    const dc = current.defaultClassification;
    if (dc && (current.rates ?? []).some((r) => r.code === dc && r.active !== false)) {
      return dc;
    }
    const first = (current.rates ?? []).find((r) => r.active !== false);
    return first?.code ?? null;
  }
  if (dryRun) {
    report.tax = { action: "would_upsert_demo_display_tax", classification: DEMO_TAX_CLASSIFICATION };
    return DEMO_TAX_CLASSIFICATION;
  }
  const saved = await ecommerce.putTaxSettings({
    ...req,
    body: demoDisplayTaxBody(current.version ?? 1),
  });
  report.tax = {
    action: isDemoOnlyTaxSettings(current) ? "upserted_demo_display_tax" : "created_demo_display_tax",
    classification: DEMO_TAX_CLASSIFICATION,
    version: saved.version,
    tag: DEMO_TAX_TAG,
  };
  return DEMO_TAX_CLASSIFICATION;
}
