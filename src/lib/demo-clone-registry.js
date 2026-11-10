import mongoose from "mongoose";
import { DemoClonePolicy } from "../constants/enums.js";
import "../models/index.js";

/**
 * Collection/field registry for demo-template publication and provisioning (plan section
 * 5.2). Every tenant-scoped Mongoose model must have a declared policy and rationale here;
 * assertRegistryCoverage() (called by scripts/check-demo-clone-registry-coverage.mjs, meant
 * to run in CI) fails the build when a newly added tenant-scoped model has no entry.
 *
 * IMPORTANT — calibration note, not false confidence: the policy/rationale pairs below are a
 * first pass, assigned by matching each model to the plan's section 5.2 grouped table and to
 * the model's name and schema shape. They are NOT a substitute for the plan's own "Phase 1:
 * Audit and contract" step, which calls for a domain-expert pass model-by-model before a real
 * template is ever published (plan section 15, phase 1 exit gate: "Every model and route has
 * an explicit demo policy; source identity confirmed."). Treat anything below as a reviewable
 * starting point, especially the digital-metal and ecommerce groups, which carry real money
 * and real external-provider identifiers.
 */

/**
 * Models that are not tenant-scoped at all (no tenantId path) and therefore cannot appear in
 * a per-tenant snapshot export in the first place. Listed explicitly so the coverage check
 * can tell "deliberately out of scope" apart from "forgotten."
 */
export const NOT_TENANT_SCOPED = Object.freeze(["SubscriptionPlan", "PlatformSettings"]);

/**
 * The Demo Builder's own control-plane models (src/models/demo.models.js). These are keyed
 * by instanceId/jobId, not tenantId — they describe demos, they are never themselves cloned
 * into a demo tenant's data, and a template snapshot never contains them.
 */
export const DEMO_CONTROL_PLANE_MODELS = Object.freeze([
  "DemoTemplate",
  "DemoTemplateVersion",
  "DemoInstance",
  "DemoProvisionJob",
  "DemoCloneMap",
  "DemoEvent",
  "DemoTemplateSnapshotChunk",
]);

const { COPY, REBUILD, SYNTHETIC, EXCLUDE } = DemoClonePolicy;

function entry(policy, rationale) {
  return { policy, rationale };
}

/** @type {Record<string, { policy: string, rationale: string }>} */
export const REGISTRY = {
  // --- Tenant, branding, branches, staff (plan 5.2 rows 1-2) ---
  Branch: entry(COPY, "Branch structures copied with new IDs; no live staff login implied."),
  User: entry(
    SYNTHETIC,
    "Staff identities replaced with synthetic reference actors; no copied passwords or usable staff sessions (plan 5.2).",
  ),

  // --- SchemePlan, Scheme, LedgerEntry (plan 5.2 row 3) ---
  SchemePlan: entry(COPY, "Full scheme rules/state copied, including embedded schedules."),
  Scheme: entry(COPY, "Customer scheme enrolments copied with rewritten customer references."),
  LedgerEntry: entry(COPY, "Full ledger history copied; money kept in paise (plan 5.2)."),

  // --- Payment, receipts, redemptions, closure/refund history (plan 5.2 row 4) ---
  Payment: entry(COPY, "Historical payments copied with rewritten refs and SAMPLE documents."),
  PaymentIntent: entry(COPY, "Historical intents copied; never eligible for live reconciliation."),
  PaymentLink: entry(EXCLUDE, "A live, customer-facing payment link; regenerate per-demo instead of cloning a real one."),
  PaymentRefund: entry(COPY, "Historical refund results copied with rewritten refs and SAMPLE output."),
  Redemption: entry(COPY, "Historical scheme redemptions copied; never eligible for live refund workers."),

  // --- GoldRate and ecommerce rate/tax data (plan 5.2 row 5) ---
  GoldRate: entry(COPY, "Rate history copied and reanchored to the template's date anchor."),

  // --- Customer, profile and KYC (plan 5.2 row 6) ---
  Customer: entry(SYNTHETIC, "Synthetic identity/mobile; KYC files replaced with sample assets, never real documents."),

  // --- Digital metal (plan 5.2 row 7) ---
  DigitalMetalAccessMarker: entry(REBUILD, "Capability/access gate state; rebuilt for the new tenant rather than copied."),
  DigitalMetalBankDestination: entry(SYNTHETIC, "Synthetic bank display samples (plan 5.2); never a real bank account."),
  DigitalMetalBuyOrder: entry(COPY, "Historical buy orders copied with rewritten references and SAMPLE documents."),
  DigitalMetalBuyPaymentAttempt: entry(COPY, "Historical payment outcomes copied; never eligible for live reconciliation."),
  DigitalMetalCustomerRiskHold: entry(REBUILD, "Volatile risk-hold state rebuilt for the new tenant, not replayed from source."),
  DigitalMetalDocumentArtifact: entry(COPY, "Customer-visible documents copied; must be regenerated with prospect branding before use."),
  DigitalMetalHedgeIncludedSource: entry(EXCLUDE, "Feeds the real platform hedge book; a demo tenant must never contribute to it."),
  DigitalMetalHedgeSnapshot: entry(EXCLUDE, "Platform-wide hedge/liability snapshot; demo tenants are excluded from hedge aggregation entirely."),
  DigitalMetalJournal: entry(COPY, "Historical journals copied; lot/journal reconciliation must stay valid after clone."),
  DigitalMetalLot: entry(COPY, "Historical lots copied; balances must reconcile with copied journals."),
  DigitalMetalNotificationIntentRepairCursor: entry(EXCLUDE, "Internal repair-worker cursor; not data, and meaningless for a fresh demo generation."),
  DigitalMetalOutboxEvent: entry(EXCLUDE, "Dispatch queue entry; always excluded as executable work (plan 5.2)."),
  DigitalMetalPayable: entry(COPY, "Historical payable records copied with rewritten references."),
  DigitalMetalPaymentExceptionRefund: entry(COPY, "Historical exception/refund outcomes copied with SAMPLE documents."),
  DigitalMetalPayout: entry(EXCLUDE, "Represents a real bank payout instruction; no live fulfilment/payout tasks in a demo (plan 5.2)."),
  DigitalMetalPhysicalOutEvent: entry(COPY, "Historical physical-delivery sample events copied; no live courier dispatch."),
  DigitalMetalProcurementEntry: entry(EXCLUDE, "Feeds real platform procurement; a demo tenant must never contribute to it."),
  DigitalMetalQuote: entry(REBUILD, "Volatile quote; rebuilt fresh rather than replaying a stale historical quote."),
  DigitalMetalRateVersion: entry(COPY, "Rate history copied and reanchored; current sample rate selected at provision time."),
  DigitalMetalRedemptionCatalogItem: entry(COPY, "Catalog item definitions copied with new tenant-scoped IDs."),
  DigitalMetalRedemptionChargeRefundCase: entry(COPY, "Historical refund case copied with rewritten references and SAMPLE output."),
  DigitalMetalRedemptionOrder: entry(COPY, "Historical redemption orders copied with rewritten references."),
  DigitalMetalRedemptionPaymentAttempt: entry(COPY, "Historical payment outcomes copied; never eligible for live reconciliation."),
  DigitalMetalReservation: entry(REBUILD, "Volatile reservation; rebuilt fresh rather than replaying a stale historical hold."),
  DigitalMetalSellOrder: entry(COPY, "Historical sell orders copied with rewritten references and SAMPLE documents."),
  DigitalMetalSettingsVersion: entry(COPY, "Terms/configuration version copied as-is (immutable record)."),
  DigitalMetalTermsPublication: entry(COPY, "Published terms content copied as-is (immutable record)."),
  DigitalMetalWallet: entry(COPY, "Wallet balances copied; must reconcile with copied lots/journals after clone."),

  // --- Ecommerce (plan 5.2 row 8) ---
  EcommerceBanner: entry(COPY, "Banners/promotions copied with sanitized copy."),
  EcommerceCart: entry(REBUILD, "Ephemeral cart; rebuilt empty rather than copied (plan 5.2)."),
  EcommerceCategory: entry(COPY, "Catalog category copied with new tenant-scoped IDs."),
  EcommerceCodRemittanceBatch: entry(EXCLUDE, "Represents real courier/bank COD remittance work; no live remittance in a demo."),
  EcommerceCodRemittanceLine: entry(EXCLUDE, "Represents real courier/bank COD remittance work; no live remittance in a demo."),
  EcommerceCustomerAddress: entry(SYNTHETIC, "Sanitized synthetic address, never a real customer address (plan 5.2)."),
  EcommerceFulfilmentSettings: entry(COPY, "Fulfilment policy/config copied as tenant configuration."),
  EcommerceGoldRate: entry(COPY, "Rate history copied and reanchored to the template's date anchor."),
  EcommerceInventory: entry(COPY, "Stock levels copied to match the cloned product catalog."),
  EcommerceInventoryAdjustment: entry(COPY, "Historical inventory adjustments copied with anonymized actors."),
  EcommerceOrder: entry(COPY, "Historical orders copied with rewritten references and SAMPLE documents."),
  EcommerceOrderCancellationRequest: entry(COPY, "Historical cancellation requests copied with rewritten references."),
  EcommerceOrderEvent: entry(COPY, "Historical order event timeline copied with rewritten references."),
  EcommercePaymentAttempt: entry(COPY, "Historical payment outcomes copied; never eligible for live reconciliation."),
  EcommercePaymentAttemptEvent: entry(COPY, "Historical payment attempt timeline copied with rewritten references."),
  EcommercePaymentExceptionRefund: entry(COPY, "Historical exception/refund outcomes copied with SAMPLE documents."),
  EcommercePriceQuote: entry(REBUILD, "Ephemeral quote/reservation; rebuilt fresh rather than copied (plan 5.2)."),
  EcommercePromotionCampaign: entry(COPY, "Promotion campaign definitions copied with sanitized copy."),
  EcommerceStockReservation: entry(REBUILD, "Ephemeral reservation; rebuilt fresh rather than copied (plan 5.2)."),
  EcommerceTaxSettings: entry(COPY, "Tax/policy configuration copied as tenant configuration."),

  // --- Cash custody, handover and adjustments (plan 5.2 row 9) ---
  CashAdjustment: entry(REBUILD, "Rebuilt/anonymized when needed for internally consistent dashboards; never touches real cash balances."),
  CashHandover: entry(REBUILD, "Rebuilt/anonymized when needed for internally consistent dashboards; never touches real cash balances."),
  CashStaffCustody: entry(REBUILD, "Rebuilt/anonymized when needed for internally consistent dashboards; never touches real cash balances."),

  // --- Alerts, inbox notifications, support/grievances (plan 5.2 row 10) ---
  Alert: entry(SYNTHETIC, "Synthetic in-app alert scenarios; non-dispatchable, no customer contact triggers."),
  Grievance: entry(SYNTHETIC, "Synthetic support scenario; replies may be scripted sample responses (plan 5.2)."),
  Message: entry(
    EXCLUDE,
    "Historical outbound message log; risk of being mistaken for dispatchable work (see OutboxEvent/WebhookEvent rows). No customer-facing need for a demo.",
  ),
  PushBroadcast: entry(EXCLUDE, "A dispatchable push campaign; demos never send real pushes."),

  // --- Counters and denormalized aggregates (plan 5.2 row 11) ---
  Counter: entry(REBUILD, "Receipt/passbook/order sequence counters rebuilt for the new tenant; verified non-colliding before use."),

  // --- Uploads, receipts, statements and invoices (plan 5.2 row 12) ---
  Upload: entry(COPY, "Safe owned objects copied into demo-owned storage; branded documents regenerated, not just copied."),

  // --- Sessions, OTP, password resets, FCM devices, integration secrets (plan 5.2 row 13: always EXCLUDE) ---
  Session: entry(EXCLUDE, "Always excluded (plan 5.2)."),
  PasswordResetToken: entry(EXCLUDE, "Always excluded (plan 5.2)."),
  DeviceRegistration: entry(EXCLUDE, "FCM device registration; always excluded (plan 5.2)."),
  PushDeviceDelivery: entry(EXCLUDE, "FCM delivery record; always excluded (plan 5.2)."),
  ReminderDailyQuota: entry(EXCLUDE, "Operational quota for real reminder dispatch; demos never dispatch reminders."),

  // --- Webhooks, dispatch queues, retry cursors, provider refund/payout instructions (plan 5.2 row 14: always EXCLUDE) ---
  WebhookEvent: entry(EXCLUDE, "Executable work from a real provider; always excluded (plan 5.2)."),
  OutboxEvent: entry(EXCLUDE, "Executable dispatch queue entry; always excluded (plan 5.2)."),
  SettlementRun: entry(EXCLUDE, "Real gateway settlement reconciliation artifact; demos are excluded from settlement entirely."),
  SettlementItem: entry(EXCLUDE, "Real gateway settlement reconciliation artifact; demos are excluded from settlement entirely."),
  SettlementMismatch: entry(EXCLUDE, "Real gateway settlement reconciliation artifact; demos are excluded from settlement entirely."),
  PostSettlementRefundCase: entry(EXCLUDE, "Real settlement-exception case; not meaningful or safe outside live reconciliation."),
  IdempotencyRecord: entry(EXCLUDE, "Internal dedupe record scoped to real requests; copying risks false-duplicate rejections."),

  // --- Platform invoices, signups, subscriptions and platform audit history (plan 5.2 row 15: EXCLUDE) ---
  Invoice: entry(EXCLUDE, "Platform subscription invoice; demos are non-billable and excluded from billing entirely (plan 3)."),
  Signup: entry(EXCLUDE, "Tenant-onboarding signup flow record; not demo-relevant content."),
  SubscriptionUpgradeRequest: entry(EXCLUDE, "Platform billing workflow record; demos are non-billable (plan 3)."),
  AuditEvent: entry(EXCLUDE, "Real staff-action audit trail; the demo lifecycle gets its own DemoEvent trail instead (plan 11)."),

  // --- Explicitly out of scope / needs its own call ---
  TemplateDefinition: entry(
    EXCLUDE,
    "Real SMS/WhatsApp message-template content for live dispatch channels, which demos never use. Also: this is the pre-existing 'message template' model the plan (section 2) warns not to confuse with the Demo Builder's own DemoTemplate/DemoTemplateVersion models above — they are unrelated and intentionally separately named.",
  ),
  ErrorLog: entry(EXCLUDE, "Real application error log, sometimes carrying a stack trace; never copied into a demo tenant."),
  ExportJob: entry(EXCLUDE, "Real report-export job record, may reference signed download URLs; regenerate per-demo instead."),
  AssistantConversation: entry(EXCLUDE, "Admin-only AI assistant conversation history; not part of the customer-facing demo surface."),
  AssistantMessage: entry(EXCLUDE, "Admin-only AI assistant conversation history; not part of the customer-facing demo surface."),
  AssistantUsageDaily: entry(EXCLUDE, "Real LLM usage/cost record; never relevant to, or safe to expose via, a demo tenant."),
  EnrolmentOperation: entry(REBUILD, "Internal one-active-scheme-per-customer mutex; rebuilt as needed, not a historically meaningful record."),
};

/**
 * @returns {string[]} tenant-scoped model names registered in mongoose that have no entry in
 * REGISTRY and are not listed in NOT_TENANT_SCOPED or DEMO_CONTROL_PLANE_MODELS.
 */
export function findUnregisteredTenantScopedModels() {
  const missing = [];
  for (const name of mongoose.modelNames()) {
    if (name in REGISTRY) continue;
    if (NOT_TENANT_SCOPED.includes(name)) continue;
    if (DEMO_CONTROL_PLANE_MODELS.includes(name)) continue;
    const schema = mongoose.model(name).schema;
    const isTenantScoped = Boolean(schema.path("tenantId"));
    if (isTenantScoped) missing.push(name);
  }
  return missing;
}

/** Throws with the full list of offending model names; see scripts/check-demo-clone-registry-coverage.mjs. */
export function assertRegistryCoverage() {
  const missing = findUnregisteredTenantScopedModels();
  if (missing.length) {
    throw new Error(
      `demo-clone-registry.js is missing a COPY/REBUILD/SYNTHETIC/EXCLUDE decision for: ${missing.join(", ")}. ` +
        "Every tenant-scoped model must have an explicit entry before it can be exported into a demo template.",
    );
  }
}
