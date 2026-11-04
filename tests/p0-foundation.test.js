import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import Decimal from "decimal.js";
import { startTestDb, resetTestDb } from "./helpers/db.js";
import { withTransaction } from "../src/lib/transaction.js";
import { OutboxEvent } from "../src/models/index.js";
import { JobStatus } from "../src/constants/enums.js";
import { enqueueEcommerceOutboxEvent } from "../src/lib/ecommerce-commerce-outbox.js";
import {
  rupeesToPaise,
  gramsToUg,
  paiseToRupeesNumber,
} from "../src/lib/ui-amount-conversion.js";
import { AppError } from "../src/lib/app-error.js";
import {
  assertBranchScopeForMutation,
  assertIdempotencyBodyMatches,
  hashMutationBody,
  assertMutationPermission,
} from "../src/lib/mutation-requirements.js";
import { codCustomerPaymentEvidence } from "../src/lib/cod-customer-payment-evidence.js";
import { mapAdminCustomerOrderListRow } from "../src/lib/ecommerce-admin-customer-order-row.js";
import {
  createStaffHandoverChallenge,
  createStaffHandoverChallengeConsumer,
  STAFF_HANDOVER_CHALLENGE_PURPOSE,
  consumeStaffHandoverChallengeWithStaffConfirmation,
} from "../src/lib/staff-handover-challenge.js";
import { Permission } from "../src/constants/permissions.js";
import { EcommerceCourierCodCollectionStatus, EcommerceOrderStatus } from "../src/constants/enums.js";

describe("ui-amount-conversion boundaries", () => {
  it("rounds half-up at paise boundaries without float error", () => {
    assert.equal(rupeesToPaise("10.55"), 1055);
    assert.equal(rupeesToPaise("0.01"), 1);
    assert.equal(rupeesToPaise("0.3"), 30);
  });

  it("rejects excess rupee precision", () => {
    assert.throws(() => rupeesToPaise("1.001"), (e) => e instanceof AppError);
  });

  it("rejects invalid and out-of-range input", () => {
    assert.throws(() => rupeesToPaise("abc"), (e) => e instanceof AppError);
    assert.throws(() => rupeesToPaise("-1"), (e) => e instanceof AppError);
  });

  it("converts grams at microgram precision", () => {
    assert.equal(gramsToUg("1.000001"), 1_000_001);
    assert.throws(() => gramsToUg("0.0000001"), (e) => e instanceof AppError);
  });

  it("paiseToRupeesNumber uses decimal not binary float display drift", () => {
    const paise = rupeesToPaise("99999999.99");
    assert.equal(paise, 9999999999);
    assert.equal(new Decimal(paise).div(100).equals(paiseToRupeesNumber(paise)), true);
  });
});

describe("mutation-requirements", () => {
  it("enforces body-bound idempotency hash match", () => {
    const body = { amountPaise: 100 };
    const record = { bodyHash: hashMutationBody(body) };
    assert.doesNotThrow(() => assertIdempotencyBodyMatches(record, body));
    assert.throws(
      () => assertIdempotencyBodyMatches(record, { amountPaise: 101 }),
      (e) => e.code === "IDEMPOTENCY_KEY_REUSED",
    );
  });

  it("enforces branch scope for branch roles", () => {
    const req = { auth: { role: "BRANCH_MANAGER", branchId: "br_a" } };
    assert.doesNotThrow(() => assertBranchScopeForMutation(req, { resourceBranchId: "br_a" }));
    assert.throws(() => assertBranchScopeForMutation(req, { resourceBranchId: "br_b" }));
  });

  it("allows tenant scope without branch equality", () => {
    const req = { auth: { role: "TENANT_OWNER" } };
    assert.doesNotThrow(() => assertBranchScopeForMutation(req, { resourceBranchId: "br_b" }));
  });

  it("checks mutation permission codes", () => {
    const req = { auth: { role: "TENANT_OWNER" } };
    assert.doesNotThrow(() => assertMutationPermission(req, Permission.ECOMMERCE_FULFILMENT_OPERATE));
    const staffReq = { auth: { role: "BRANCH_STAFF" } };
    assert.throws(() => assertMutationPermission(staffReq, Permission.ECOMMERCE_WRITE));
  });
});

describe("cod customer paid evidence", () => {
  it("does not treat delivered status as customer paid without collection evidence", () => {
    const row = {
      _id: "ord_1",
      paymentMethod: "COD",
      status: EcommerceOrderStatus.DELIVERED,
      totalPaise: 50000,
      courierCod: { collectionStatus: EcommerceCourierCodCollectionStatus.PENDING },
      lines: [],
    };
    const evidence = codCustomerPaymentEvidence(row);
    assert.equal(evidence.collectionConfirmed, false);
    assert.equal(evidence.label, "Payment unconfirmed");
    const mapped = mapAdminCustomerOrderListRow(row, null);
    assert.equal(mapped.codCustomerPaidLabel, "Payment unconfirmed");
    assert.equal(mapped.paymentCollected, false);
  });

  it("marks customer paid only when courier collection is confirmed", () => {
    const row = {
      _id: "ord_2",
      paymentMethod: "COD",
      status: EcommerceOrderStatus.SHIPPED,
      totalPaise: 50000,
      courierCod: {
        collectionStatus: EcommerceCourierCodCollectionStatus.CONFIRMED,
        collectionConfirmedAt: new Date(),
      },
      lines: [],
    };
    const mapped = mapAdminCustomerOrderListRow(row, null);
    assert.equal(mapped.codCustomerPaidLabel, "Customer paid");
    assert.equal(mapped.paymentCollected, true);
  });
});

describe("staff handover challenge consume", () => {
  it("requires explicit staff handover confirmation", () => {
    const binding = {
      orderId: "ord_1",
      customerId: "cus_1",
      branchId: "br_1",
      purpose: STAFF_HANDOVER_CHALLENGE_PURPOSE.ECOMMERCE_PICKUP_LEGACY_CONFIRM,
    };
    const created = createStaffHandoverChallenge(binding);
    assert.throws(
      () =>
        consumeStaffHandoverChallengeWithStaffConfirmation(created, {
          submittedCode: created.challengeCode,
          binding,
          staffUserId: "staff_1",
          staffHandoverConfirmed: false,
        }),
      (e) => e.code === "STAFF_HANDOVER_CONFIRMATION_REQUIRED",
    );
  });

  it("allows only one concurrent consume", async () => {
    const binding = {
      orderId: "ord_1",
      customerId: "cus_1",
      branchId: "br_1",
      purpose: STAFF_HANDOVER_CHALLENGE_PURPOSE.ECOMMERCE_PICKUP_STAFF_VERIFY,
    };
    const created = createStaffHandoverChallenge(binding);
    const consumer = createStaffHandoverChallengeConsumer(created);
    const params = {
      submittedCode: created.challengeCode,
      binding,
      staffUserId: "staff_1",
      staffHandoverConfirmed: true,
    };
    const results = await Promise.allSettled([consumer.consume(params), consumer.consume(params)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(["HANDOVER_CHALLENGE_USED", "HANDOVER_CHALLENGE_INVALID"].includes(rejected[0].reason?.code));
  });
});

test("outbox and domain marker roll back together on transaction failure", async () => {
  await startTestDb();
  await resetTestDb();
  const tenantId = "ten_p0_outbox";
  const topic = "ecommerce.test.p0_rollback";
  const key = "rollback-key";
  try {
    await assert.rejects(
      () =>
        withTransaction(async (session) => {
          await OutboxEvent.create(
            [
              {
                tenantId,
                topic,
                key,
                payload: { marker: true },
                status: JobStatus.QUEUED,
                availableAt: new Date(),
              },
            ],
            { session },
          );
          await enqueueEcommerceOutboxEvent({
            tenantId,
            topic,
            key: `${key}:second`,
            payload: { nested: true },
            session,
          });
          throw new Error("SIMULATED_DOMAIN_FAILURE");
        }),
      /SIMULATED_DOMAIN_FAILURE/,
    );
    assert.equal(await OutboxEvent.countDocuments({ tenantId, topic }), 0);
  } finally {
    await resetTestDb();
  }
});
