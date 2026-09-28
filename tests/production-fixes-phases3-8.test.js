import test from "node:test";
import assert from "node:assert/strict";
import { phonePeProvider } from "../src/integrations/phonepe.provider.js";
import {
  AlertStatus,
  AlertType,
  PaymentIntentStatus,
  PaymentStatus,
} from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import {
  armMockOrderStatusTemplate,
  armMockRefundInitTemplate,
  clearPhonePeProviderTestHooks,
} from "../src/lib/phonepe-provider-test-hooks.js";
import {
  reopenOperationalAlert,
  resolveOperationalAlert,
} from "../src/lib/operational-alert.js";
import {
  displayInvoiceNumber,
  subscriptionInvoiceTaxBreakdown,
} from "../src/services/subscription-invoice-pdf.service.js";
import { processPhonePeRefundWebhook } from "../src/services/phonepe-refund.service.js";
import { rebuildSchemeProjection } from "../src/services/scheme.service.js";
import { assessMaturityContributionEligibility } from "../src/lib/maturity-eligibility.js";
import { tenantOperationsPatchBody } from "../src/validators/common.validators.js";
import { Alert, Invoice, Payment, PaymentIntent } from "../src/models/index.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  clearPhonePeProviderTestHooks();
});

test("displayInvoiceNumber prefers invoiceNumber over reference", () => {
  assert.equal(
    displayInvoiceNumber({ invoiceNumber: "PLT/2026/0001", reference: "REF-1", _id: "inv_x" }),
    "PLT/2026/0001",
  );
  assert.equal(displayInvoiceNumber({ reference: "REF-1", _id: "inv_x" }), "REF-1");
});

test("subscription tax breakdown honors non-18% persisted rate", () => {
  const breakdown = subscriptionInvoiceTaxBreakdown({
    subtotalPaise: 10_000,
    taxPaise: 500,
    taxPercent: 5,
    amountPaise: 10_500,
  });
  assert.equal(breakdown.taxable + breakdown.gst, breakdown.total);
  assert.equal(breakdown.gst, 500);
});

test("duplicate invoiceNumber rejected at database level", async () => {
  await Invoice.syncIndexes();
  const { tenant } = await seedTenantUser();
  await Invoice.create({
    _id: createId("inv"),
    tenantId: tenant._id,
    invoiceNumber: "PLT/2026/0099",
    amountPaise: 1000,
    status: "ISSUED",
  });
  await assert.rejects(
    () =>
      Invoice.create({
        _id: createId("inv"),
        tenantId: tenant._id,
        invoiceNumber: "PLT/2026/0099",
        amountPaise: 2000,
        status: "ISSUED",
      }),
    /E11000/,
  );
});

test("tenant operations rejects unknown kycAllowedTypes", () => {
  const parsed = tenantOperationsPatchBody.safeParse({
    expectedVersion: 1,
    kycAllowedTypes: ["PASSPORT"],
  });
  assert.equal(parsed.success, false);
});

test("tenant operations deduplicates kycAllowedTypes", () => {
  const parsed = tenantOperationsPatchBody.parse({
    expectedVersion: 1,
    kycAllowedTypes: ["PAN", "PAN", "AADHAAR"],
  });
  assert.deepEqual(parsed.kycAllowedTypes, ["PAN", "AADHAAR"]);
});

test("20 concurrent reopen calls leave one OPEN alert with latest title", async () => {
  const { tenant } = await seedTenantUser();
  const entityId = createId("pay");
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      reopenOperationalAlert({
        tenantId: tenant._id,
        type: AlertType.GATEWAY_SETTLEMENT_MISMATCH,
        entityId,
        title: `Reopen ${index}`,
        message: "msg",
      })),
  );
  const openCount = await Alert.countDocuments({
    tenantId: tenant._id,
    type: AlertType.GATEWAY_SETTLEMENT_MISMATCH,
    entityId,
    status: AlertStatus.OPEN,
  });
  assert.equal(openCount, 1);
  const open = await Alert.findOne({
    tenantId: tenant._id,
    entityId,
    status: AlertStatus.OPEN,
  }).lean();
  assert.ok(/^Reopen \d+$/.test(open.title));
  await resolveOperationalAlert({
    tenantId: tenant._id,
    type: AlertType.GATEWAY_SETTLEMENT_MISMATCH,
    entityId,
  });
  const resolvedCount = await Alert.countDocuments({
    tenantId: tenant._id,
    entityId,
    status: AlertStatus.RESOLVED,
  });
  assert.equal(resolvedCount, 1);
});

test("PhonePe provider hooks cannot arm outside NODE_ENV=test", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => armMockOrderStatusTemplate("id", "__mock_completed__"), /NODE_ENV=test/);
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test("mock order status uses armed hook not merchant id substring", async () => {
  const orderId = createId("paymentIntent");
  armMockOrderStatusTemplate(orderId, "__mock_completed__");
  const status = await phonePeProvider.getOrderStatus(orderId, {}, "tenant");
  assert.equal(status.state, "COMPLETED");
  const pending = await phonePeProvider.getOrderStatus(createId("paymentIntent"), {}, "tenant");
  assert.equal(pending.state, "PENDING");
});

test("ACCEPTED refund callback without amount does not create PaymentRefund", async () => {
  const { tenant, branch } = await seedTenantUser();
  const paymentId = createId("payment");
  const intentId = createId("paymentIntent");
  await Payment.create({
    _id: paymentId,
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: createId("scheme"),
    customerId: createId("customer"),
    receiptNumber: "R-1",
    amountPaise: 100_000,
    status: PaymentStatus.SUCCESS,
    mode: "ONLINE_GATEWAY",
    source: "CUSTOMER_APP",
    paidAt: new Date(),
  });
  await PaymentIntent.create({
    _id: intentId,
    tenantId: tenant._id,
    paymentId,
    status: PaymentIntentStatus.SUCCEEDED,
    amountPaise: 100_000,
    positionVersion: 1,
  });
  const providerRefundId = createId("pref");
  const first = await processPhonePeRefundWebhook({
    tenantId: tenant._id,
    type: "PG_REFUND_ACCEPTED",
    payload: { refundId: providerRefundId, merchantOrderId: intentId },
    providerEventId: `evt-${providerRefundId}`,
  });
  assert.equal(first.outcome, "NEEDS_REVIEW");
  const replay = await processPhonePeRefundWebhook({
    tenantId: tenant._id,
    type: "PG_REFUND_ACCEPTED",
    payload: { refundId: providerRefundId, merchantOrderId: intentId },
    providerEventId: `evt-${providerRefundId}`,
  });
  assert.equal(replay.outcome, "NEEDS_REVIEW");
  assert.equal(await Alert.countDocuments({ tenantId: tenant._id, type: AlertType.GATEWAY_REFUND_AMOUNT_UNRESOLVED }), 1);
});

test("flexible capped cycle with partial pay counts as contributed in projection", () => {
  const scheme = {
    paymentPattern: "FLEXIBLE",
    positionVersion: 0,
    cycles: [{ cycle: "2026-01", capPaise: 10_000, paidPaise: 0, status: "UPCOMING", expiresAt: "2026-12-31" }],
    installments: [],
  };
  rebuildSchemeProjection(scheme, [
    { type: "INSTALLMENT_PAYMENT", cycle: "2026-01", amountPaise: 2_000, sequence: 1 },
  ]);
  assert.equal(scheme.cycles[0].status, "PARTIALLY_PAID");
  const eligibility = assessMaturityContributionEligibility({
    paymentPattern: "FLEXIBLE",
    flexiblePhase: "CAPPED",
    cycles: scheme.cycles,
    planSnapshot: {
      paymentPattern: "FLEXIBLE",
      flexibleRules: { cappedPhaseCycles: 1, flexiblePhaseCycles: 0 },
    },
  });
  assert.equal(eligibility.contributionEligible, true);
});

test("refund init hook throws only under test when armed", async () => {
  const refundId = createId("pref");
  armMockRefundInitTemplate(refundId, "__mock_init_reject__");
  await assert.rejects(
    () =>
      phonePeProvider.initiateRefund({
        merchantRefundId: refundId,
        originalMerchantOrderId: createId("paymentIntent"),
        amountPaise: 1000,
        credentials: {},
        tenantId: "tenant",
      }),
    (error) => error?.code === "PHONEPE_REFUND_REJECTED",
  );
});
