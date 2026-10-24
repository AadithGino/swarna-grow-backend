import { EcommerceCheckoutTaxPresentation } from "../../src/constants/enums.js";

export const INTRA_COMPONENT_LINES = [
  { componentKey: "CGST", label: "CGST", rateBps: 150 },
  { componentKey: "SGST", label: "SGST", rateBps: 150 },
];

export const INTER_COMPONENT_LINES = [
  { componentKey: "IGST", label: "IGST", rateBps: 300 },
];

export function taxReadyCatalogBody() {
  return {
    rates: [{ code: "GST_3", rateBps: 300, active: true }],
    defaultClassification: "GST_3",
    hsnSacMappings: [
      { classification: "GST_3", hsnSacCode: "7113", hsnSacType: "HSN" },
    ],
  };
}

export function taxReadyCheckoutTaxConfig() {
  return {
    presentation: EcommerceCheckoutTaxPresentation.ACCOUNTANT_COMPONENT_APPROVED,
    sellerLegalName: "Test Jewellers",
    sellerGstin: "32ABCDE1234F1Z5",
    registeredState: "Kerala",
    defaultPlaceOfSupplyState: "Kerala",
    defaultItemTaxClassification: "GST_3",
    accountantSignOffReference: "CA-1",
    accountantApprovedAt: new Date().toISOString(),
    componentLines: INTRA_COMPONENT_LINES,
    componentRules: [
      { supplyCase: "INTRA_STATE", componentLines: INTRA_COMPONENT_LINES },
      { supplyCase: "INTER_STATE", componentLines: INTER_COMPONENT_LINES },
    ],
    supportedDestinationStates: ["Kerala"],
  };
}

/** Enables order create + payment APIs in NODE_ENV=test only (never via HTTP headers). */
export function enableEcommercePaymentsTestHarness() {
  process.env.NODE_ENV = "test";
  process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "true";
}

export function disableEcommercePaymentsTestHarness() {
  process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS = "false";
}

const POLICY_PLACEHOLDER =
  "Jeweller-maintained policy text for automated tests only. Contact the store for authoritative terms.";

export function taxReadyStorePolicies() {
  const approvedAt = new Date().toISOString();
  return {
    version: 1,
    publishedAt: approvedAt,
    shippingPolicyText: POLICY_PLACEHOLDER,
    shippingPolicyApprovedAt: approvedAt,
    returnsPolicyText: POLICY_PLACEHOLDER,
    returnsPolicyApprovedAt: approvedAt,
    cancellationPolicyText: POLICY_PLACEHOLDER,
    cancellationPolicyApprovedAt: approvedAt,
    refundContactPolicyText: POLICY_PLACEHOLDER,
    refundContactPolicyApprovedAt: approvedAt,
    returnEligibilityDays: 7,
    returnExcludedCategoryIds: [],
  };
}

export function taxReadyFulfilmentBody(branchId) {
  return {
    expectedVersion: 1,
    pickupEnabled: true,
    pickupBranchIds: [branchId],
    pendingPaymentWindowMinutes: 30,
    checkoutTaxConfig: taxReadyCheckoutTaxConfig(),
    storePolicies: taxReadyStorePolicies(),
  };
}
