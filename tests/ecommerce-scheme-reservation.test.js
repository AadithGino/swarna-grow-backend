import assert from "node:assert/strict";
import test from "node:test";
import { allocateSchemeBenefit, calculateSchemeReturn, remainingSchemeEntitlement } from "../src/lib/ecommerce-scheme-reservation-accounting.js";

test("held and consumed funds reduce the available balance; released holds do not", () => {
  const reservations = [
    { basis: "GOLD_WEIGHT", status: "HELD", units: 1000, waiverPaise: 5000 },
    { basis: "GOLD_WEIGHT", status: "CONSUMED", units: 2500, restoredUnits: 500,
      waiverPaise: 8000, restoredWaiverPaise: 2000 },
    { basis: "CASH_VALUE", status: "RELEASED", units: 2000, waiverPaise: 10000 },
  ];
  assert.deepEqual(remainingSchemeEntitlement({ balance: 10000, basis: "GOLD_WEIGHT",
    waiverCapPaise: 40000, reservations }), { balance: 7000, waiverCapPaise: 29000 });
  assert.throws(() => remainingSchemeEntitlement({ balance: 100000, basis: "CASH_VALUE", reservations }),
    { code: "SCHEME_SETTLEMENT_BASIS_IN_USE" });
});

test("split returns restore exact original amounts and never include waived charges in cash", () => {
  const start = allocateSchemeBenefit([
    { productId: "ring", quantity: 3, schemeUnits: 1001, cashPaise: 10001, waiverPaise: 500 },
  ], 250);
  const first = calculateSchemeReturn(start, [{ productId: "ring", quantity: 1 }]);
  const last = calculateSchemeReturn(first.lines, [{ productId: "ring", quantity: 2 }]);
  assert.equal(first.restoredUnits + last.restoredUnits, 1001);
  assert.equal(first.restoredBenefitUnits, 83);
  assert.equal(first.restoredBenefitUnits + last.restoredBenefitUnits, 250);
  assert.equal(first.refundedCashPaise + last.refundedCashPaise, 10001);
  assert.equal(first.restoredWaiverPaise + last.restoredWaiverPaise, 500);
  assert.throws(() => calculateSchemeReturn(last.lines, [{ productId: "ring", quantity: 1 }]),
    { code: "INVALID_SCHEME_RETURN" });
});

test("order transactions reject concurrent reservations and restore a return only once", async () => {
  const { startTestDb, stopTestDb, resetTestDb, seedTenantUser, seedCustomer } = await import("./helpers/db.js");
  const { Scheme, EcommerceOrder, EcommerceSchemeReservation } = await import("../src/models/index.js");
  const { withTransaction } = await import("../src/lib/transaction.js");
  const { getSchemePurchaseEntitlement, reserveSchemeForOrder, resolveSchemeOrderHold, restoreSchemeOrderReturn } =
    await import("../src/services/ecommerce-scheme-reservation.service.js");
  await startTestDb();
  try {
    await resetTestDb();
    await EcommerceSchemeReservation.init();
    const { tenant, branch } = await seedTenantUser();
    const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
    await Scheme.collection.insertOne({
      _id: "scheme_order_accounting", tenantId: tenant._id, branchId: branch._id,
      customerId: customer._id, status: "MATURED", version: 1,
    });
    const entitlement = { tenantId: tenant._id, schemeId: "scheme_order_accounting",
      basis: "CASH_VALUE", balance: 1000, waiverCapPaise: 200 };
    const reserve = (orderId, schemeVersion, units) => withTransaction((session) => reserveSchemeForOrder({
      ...entitlement, customerId: customer._id, orderId, schemeVersion, session,
      lines: [{ productId: "ring", quantity: 2, schemeUnits: units, schemePaise: units, cashPaise: 201, waiverPaise: 100 }],
    }));
    const competing = await Promise.allSettled([reserve("order_a", 1, 750), reserve("order_b", 1, 750)]);
    assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await getSchemePurchaseEntitlement(entitlement)).balance, 250);
    const orderId = competing.find((result) => result.status === "fulfilled").value.orderId;
    await assert.rejects(reserve("order_c", 2, 251), { code: "SCHEME_RESERVATION_INSUFFICIENT" });
    await withTransaction((session) => resolveSchemeOrderHold({ tenantId: tenant._id, orderId, status: "CONSUMED", session }));
    const restore = () => withTransaction((session) => restoreSchemeOrderReturn({
      tenantId: tenant._id, orderId, reference: "return_first", items: [{ productId: "ring", quantity: 1 }], session,
    }));
    const first = await restore();
    const second = await restore();
    assert.equal(first.refundedCashPaise, 100);
    assert.equal(second.refundedCashPaise, 100);
    assert.equal((await getSchemePurchaseEntitlement(entitlement)).balance, 625);
    const held = await reserve("order_d", 2, 400);
    await EcommerceOrder.collection.insertOne({
      _id: "order_d", tenantId: tenant._id, customerId: customer._id, orderNumber: "TEST-EXPIRY",
      status: "PENDING_PAYMENT", version: 1, expiresAt: new Date(0),
      financialSnapshot: { schemePurchase: { reservationId: held._id } },
    });
    const { expirePendingPaymentOrderRow } = await import("../src/lib/ecommerce-order-lifecycle.js");
    const expire = () => withTransaction((session) => expirePendingPaymentOrderRow({
      tenantId: tenant._id, orderId: "order_d", session,
    }));
    assert.equal((await expire()).status, "PAYMENT_EXPIRED");
    assert.equal(await expire(), null);
    assert.equal((await getSchemePurchaseEntitlement(entitlement)).balance, 625);
  } finally {
    await stopTestDb();
  }
});
