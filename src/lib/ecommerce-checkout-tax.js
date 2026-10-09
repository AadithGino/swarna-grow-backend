import {
  EcommerceCheckoutTaxPresentation,
  EcommerceTaxSupplyCase,
} from "../constants/enums.js";
import { addPaise, mulDivHalfUpPaise } from "./ecommerce-exact-money.js";
import { normalizeIndianStateName, pickComponentLinesForSupplyCase } from "./ecommerce-place-of-supply.js";

const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{13}$/;
const HSN_SAC_RE = /^[0-9A-Z]{4,8}$/;

function validateComponentLines(lines, blockers, prefix) {
  if (!lines.length) {
    blockers.push({
      code: "MISSING_COMPONENT_TAX_LINES",
      message: `${prefix}: enter accountant-approved component tax lines (platform does not infer CGST/SGST/IGST).`,
    });
    return;
  }
  for (const [index, line] of lines.entries()) {
    if (!String(line.componentKey ?? "").trim() || !String(line.label ?? "").trim()) {
      blockers.push({
        code: "INVALID_COMPONENT_LINE",
        message: `${prefix}: component line ${index + 1} requires key and label.`,
      });
    }
    if (!Number.isInteger(line.rateBps) || line.rateBps < 0) {
      blockers.push({
        code: "INVALID_COMPONENT_RATE",
        message: `${prefix}: component line ${index + 1} requires a valid rate in basis points.`,
      });
    }
  }
}

export function resolveProductHsnSac(product, taxSettings) {
  const code = String(product?.hsnSacCode ?? "").trim().toUpperCase();
  const type = product?.hsnSacType;
  if (code && type) {
    if (!HSN_SAC_RE.test(code)) {
      return { ok: false, code: "INVALID_PRODUCT_HSN_SAC" };
    }
    return { ok: true, hsnSacCode: code, hsnSacType: type, source: "PRODUCT" };
  }
  const classification = String(
    product?.taxClassification ?? taxSettings?.defaultClassification ?? "",
  ).trim();
  const mappings = taxSettings?.hsnSacMappings ?? [];
  const row = mappings.find((m) => m.classification === classification);
  if (!row?.hsnSacCode || !row?.hsnSacType) {
    return { ok: false, code: "MISSING_HSN_SAC_MAPPING", classification };
  }
  const mapped = String(row.hsnSacCode).trim().toUpperCase();
  if (!HSN_SAC_RE.test(mapped)) {
    return { ok: false, code: "INVALID_HSN_SAC_MAPPING", classification };
  }
  return {
    ok: true,
    hsnSacCode: mapped,
    hsnSacType: row.hsnSacType,
    source: "CLASSIFICATION",
    classification,
  };
}

export function evaluateCheckoutTaxReadiness(taxSettings, fulfilmentSettingsRow) {
  const blockers = [];
  const config = fulfilmentSettingsRow?.checkoutTaxConfig ?? {};
  const presentation = config.presentation ?? EcommerceCheckoutTaxPresentation.UNCONFIGURED;

  const rates = (taxSettings?.rates ?? []).filter((r) => r.active !== false);
  if (!taxSettings?.defaultClassification) {
    blockers.push({ code: "MISSING_CATALOG_DEFAULT_CLASSIFICATION", message: "Set a default tax classification in ecommerce tax settings." });
  }
  if (!rates.length) {
    blockers.push({ code: "MISSING_ACTIVE_TAX_RATES", message: "Add at least one active tax rate in ecommerce tax settings." });
  }

  if (presentation === EcommerceCheckoutTaxPresentation.UNCONFIGURED) {
    blockers.push({
      code: "TAX_PRESENTATION_UNCONFIGURED",
      message: "Accountant must choose tax presentation and component lines before live checkout.",
    });
    return { ready: false, blockers, presentation };
  }

  if (presentation === EcommerceCheckoutTaxPresentation.SINGLE_ESTIMATE_ONLY) {
    blockers.push({
      code: "CHECKOUT_BLOCKED_ESTIMATE_ONLY",
      message: "Single-rate estimates are for display only until accountant-approved component tax is configured.",
    });
    return { ready: false, blockers, presentation };
  }

  if (!String(config.sellerLegalName ?? "").trim()) {
    blockers.push({ code: "MISSING_SELLER_LEGAL_NAME", message: "Seller legal name is required." });
  }
  const gstin = String(config.sellerGstin ?? "").trim().toUpperCase();
  if (!GSTIN_RE.test(gstin)) {
    blockers.push({ code: "MISSING_OR_INVALID_SELLER_GSTIN", message: "Seller GSTIN must be 15 characters (accountant verified)." });
  }
  if (!String(config.registeredState ?? "").trim()) {
    blockers.push({ code: "MISSING_REGISTERED_STATE", message: "Seller registered state is required." });
  }
  if (!String(config.defaultPlaceOfSupplyState ?? "").trim()) {
    blockers.push({ code: "MISSING_DEFAULT_PLACE_OF_SUPPLY", message: "Default place of supply state is required." });
  }
  const classification = String(config.defaultItemTaxClassification ?? "").trim();
  if (!classification) {
    blockers.push({ code: "MISSING_DEFAULT_ITEM_CLASSIFICATION", message: "Default item tax classification is required." });
  } else if (!rates.some((r) => r.code === classification)) {
    blockers.push({ code: "UNKNOWN_ITEM_CLASSIFICATION", message: "Default item classification must match an active tax rate code." });
  }
  if (!String(config.accountantSignOffReference ?? "").trim()) {
    blockers.push({ code: "MISSING_ACCOUNTANT_SIGN_OFF", message: "Accountant sign-off reference is required." });
  }
  if (!config.accountantApprovedAt) {
    blockers.push({ code: "MISSING_ACCOUNTANT_APPROVED_AT", message: "Accountant approval date is required." });
  }

  const defaultHsn = resolveProductHsnSac(
    { taxClassification: classification },
    taxSettings,
  );
  if (!defaultHsn.ok) {
    blockers.push({
      code: "MISSING_HSN_SAC_MAPPING",
      message: "Map HSN/SAC for the default item tax classification before checkout.",
    });
  }

  const supported = config.supportedDestinationStates ?? [];
  if (fulfilmentSettingsRow?.deliveryEnabled && !supported.length) {
    blockers.push({
      code: "MISSING_SUPPORTED_DESTINATIONS",
      message: "List supported destination states for delivery checkout.",
    });
  }

  if (presentation === EcommerceCheckoutTaxPresentation.ACCOUNTANT_COMPONENT_APPROVED) {
    const intraLines = pickComponentLinesForSupplyCase(config, EcommerceTaxSupplyCase.INTRA_STATE);
    validateComponentLines(intraLines, blockers, "Intra-state supply");
    const needsInter =
      fulfilmentSettingsRow?.deliveryEnabled
      || supported.some(
        (s) => normalizeIndianStateName(s) !== normalizeIndianStateName(config.registeredState),
      );
    if (needsInter) {
      const interLines = pickComponentLinesForSupplyCase(config, EcommerceTaxSupplyCase.INTER_STATE);
      validateComponentLines(interLines, blockers, "Inter-state supply");
    }
  }

  return {
    ready: blockers.length === 0,
    blockers,
    presentation,
  };
}

/** Accountant-entered component rates applied to taxable base (integer paise, half-up). */
export function computeComponentTaxPaise(taxableBasePaise, componentLines = []) {
  const lines = [];
  let totalPaise = 0;
  for (const raw of componentLines) {
    const componentKey = String(raw.componentKey ?? "").trim();
    const label = String(raw.label ?? "").trim();
    const rateBps = Number(raw.rateBps);
    const taxPaise = mulDivHalfUpPaise(taxableBasePaise, rateBps, 10_000);
    lines.push({ componentKey, label, rateBps, taxableBasePaise, taxPaise });
    totalPaise = addPaise(totalPaise, taxPaise);
  }
  return { lines, totalPaise };
}

export function mapCheckoutReadiness(taxSettings, fulfilmentSettingsRow) {
  const tax = evaluateCheckoutTaxReadiness(taxSettings, fulfilmentSettingsRow);
  return {
    checkoutUsable: false,
    checkoutTaxReady: tax.ready,
    taxPresentation: tax.presentation,
    blockers: tax.blockers,
  };
}
