import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommerceFulfilmentMode,
  EcommercePriceMode,
  EcommerceStockPolicy,
  PlanTier,
  TenantRole,
  UserStatus,
  UserType,
} from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { UG_PER_G } from "../src/lib/digital-metals-quote-engine.js";
import {
  CashAdjustment,
  DigitalMetalBankDestination,
  DigitalMetalBuyOrder,
  DigitalMetalPayable,
  DigitalMetalSellOrder,
  DigitalMetalWallet,
  EcommerceOrder,
  Session,
  Tenant,
  User,
} from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { seal } from "../src/lib/crypto.js";
import { withTransaction } from "../src/lib/transaction.js";
import { creditWalletForTest } from "../src/services/digital-metals-ledger.service.js";
import { signAccessToken } from "../src/services/token.service.js";
import * as ecommerce from "../src/services/ecommerce.service.js";
import {
  bearerFor,
  resetTestDb,
  seedBranch,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";
import { makeTenantQuoteReady } from "./helpers/digital-metals-live-ready.js";
import {
  disableEcommercePaymentsTestHarness,
  taxReadyCatalogBody,
  taxReadyFulfilmentBody,
} from "./helpers/ecommerce-checkout-fixtures.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
  disableEcommercePaymentsTestHarness();
});

let staffSeq = 0;
async function seedStaff({ tenant, branch, role }) {
  staffSeq += 1;
  const user = await User.create({
    _id: createId("user"),
    type: UserType.TENANT_USER,
    tenantId: tenant._id,
    branchId: branch._id,
    role,
    name: `${role} ${staffSeq}`,
    mobile: `+9177${String(10_000_000 + staffSeq).slice(-8)}`,
    passwordHash: "x",
    status: UserStatus.ACTIVE,
    permissions: ROLE_PERMISSIONS[role] ?? [],
  });
  const session = await Session.create({
    _id: createId("session"),
    userId: user._id,
    tenantId: tenant._id,
    deviceId: "test-device",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "web",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  user.$locals.testSessionId = session._id;
  return user;
}

async function enableDigitalGold(tenantId) {
  await Tenant.updateOne(
    { _id: tenantId },
    {
      $set: {
        "subscription.planFeaturesSnapshot.digitalMetals": true,
        "subscription.tier": PlanTier.GROWTH,
        "operations.digitalMetalsEnabled": true,
      },
    },
  );
}

async function customerToken({ tenant, branch, customer }) {
  const session = await Session.create({
    _id: createId("session"),
    customerId: customer._id,
    tenantId: tenant._id,
    deviceId: "cust",
    familyId: createId("family"),
    refreshTokenHash: createId("refresh"),
    platform: "android",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return signAccessToken({
    id: customer._id,
    type: "CUSTOMER",
    tenantId: tenant._id,
    branchId: branch._id,
    role: "CUSTOMER",
    permissions: [],
    deviceId: "cust",
    securityVersion: 0,
    sessionId: session._id,
  });
}

function post(path, token, body) {
  return request(app)
    .post(`/api/v1/admin${path}`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Idempotency-Key", randomUUID())
    .send(body);
}

async function digitalGoldReady() {
  const { tenant, branch, user: owner } = await seedTenantUser({});
  await enableDigitalGold(tenant._id);
  await makeTenantQuoteReady(app, tenant._id, bearerFor(owner));
  const manager = await seedStaff({ tenant, branch, role: TenantRole.BRANCH_MANAGER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  return { tenant, branch, owner, manager, customer };
}

test("branch manager buys Digi Gold for a customer paid in cash: grams credited and cash posted", async () => {
  const { tenant, manager, customer } = await digitalGoldReady();
  const token = bearerFor(manager);
  const quote = await post(`/digital-metals/customers/${customer._id}/counter/buy-quote`, token, {
    metal: "GOLD",
    finenessPpm: 999_000,
    inputMode: "QUANTITY_UG",
    quantityUg: UG_PER_G,
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  assert.ok(quote.body.data.totalPayablePaise > 0);

  const key = randomUUID();
  const send = () =>
    request(app)
      .post(`/api/v1/admin/digital-metals/customers/${customer._id}/counter/buy`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Idempotency-Key", key)
      .send({ quoteId: quote.body.data.quoteId, paymentMode: "CASH", customerConsent: true });
  const buy = await send();
  assert.equal(buy.status, 201, JSON.stringify(buy.body));
  assert.equal(buy.body.data.order.status, "CREDITED");
  assert.equal(buy.body.data.order.channel, "COUNTER");
  assert.equal(buy.body.data.cashCustody, "STAFF");

  const wallet = await DigitalMetalWallet.findOne({ tenantId: tenant._id, customerId: customer._id }).lean();
  assert.equal(wallet.heldUg, UG_PER_G);
  const cash = await CashAdjustment.find({ tenantId: tenant._id, staffId: manager._id }).lean();
  assert.equal(cash.length, 1);
  assert.equal(cash[0].direction, "CREDIT");
  assert.equal(cash[0].amountPaise, quote.body.data.totalPayablePaise);

  const replay = await send();
  assert.ok([200, 201].includes(replay.status));
  assert.equal(replay.body.data.order.id, buy.body.data.order.id);
  assert.equal(await DigitalMetalBuyOrder.countDocuments({ tenantId: tenant._id }), 1);
  assert.equal(await CashAdjustment.countDocuments({ tenantId: tenant._id }), 1);
});

test("counter buy by UPI needs a reference and the counter quote cannot be used from the app", async () => {
  const { tenant, branch, owner, customer } = await digitalGoldReady();
  const token = bearerFor(owner);
  const quote = await post(`/digital-metals/customers/${customer._id}/counter/buy-quote`, token, {
    metal: "GOLD",
    finenessPpm: 999_000,
    inputMode: "BUDGET_INR",
    budgetPaise: 500_000,
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const noRef = await post(`/digital-metals/customers/${customer._id}/counter/buy`, token, {
    quoteId: quote.body.data.quoteId,
    paymentMode: "UPI",
    customerConsent: true,
  });
  assert.equal(noRef.status, 400);

  const appToken = await customerToken({ tenant, branch, customer });
  const fromApp = await request(app)
    .post("/api/v1/app/digital-metals/buy-orders")
    .set("Authorization", `Bearer ${appToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      quoteId: quote.body.data.quoteId,
      termsVersionAccepted: quote.body.data.termsVersion,
      termsContentHashAccepted: quote.body.data.termsContentHash,
    });
  assert.equal(fromApp.status, 422);
  assert.equal(fromApp.body.error?.code, "QUOTE_NOT_EXECUTABLE");

  const upi = await post(`/digital-metals/customers/${customer._id}/counter/buy`, token, {
    quoteId: quote.body.data.quoteId,
    paymentMode: "UPI",
    paymentReference: "UTR123456789",
    customerConsent: true,
  });
  assert.equal(upi.status, 201, JSON.stringify(upi.body));
  assert.equal(upi.body.data.order.status, "CREDITED");
  assert.equal(upi.body.data.cashCustody, null);
  assert.equal(await CashAdjustment.countDocuments({ tenantId: tenant._id }), 0);
});

test("counter sell paid in cash waits for approval, then cash payout settles it", async () => {
  const { tenant, manager, owner, customer } = await digitalGoldReady();
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: 2 * UG_PER_G,
      idempotencyKey: `seed-${randomUUID()}`,
    }),
  );
  const token = bearerFor(manager);
  const quote = await post(`/digital-metals/customers/${customer._id}/counter/sell-quote`, token, {
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: UG_PER_G,
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const sell = await post(`/digital-metals/customers/${customer._id}/counter/sell`, token, {
    quoteId: quote.body.data.quoteId,
    payoutMethod: "CASH",
    customerConsent: true,
  });
  assert.equal(sell.status, 201, JSON.stringify(sell.body));
  const orderId = sell.body.data.order.id;
  assert.equal(sell.body.data.order.status, "PENDING_APPROVAL");
  assert.equal(sell.body.data.order.payoutMethod, "CASH");

  const early = await post(`/digital-metals/sell-orders/${orderId}/cash-payout`, token, {});
  assert.equal(early.status, 409);
  assert.equal(early.body.error?.code, "SELL_NOT_APPROVED");

  const approve = await post(`/digital-metals/sell-orders/${orderId}/approve`, bearerFor(owner), {});
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  assert.equal(approve.body.data.status, "PAYABLE_OPEN");

  const payable = await DigitalMetalPayable.findOne({ sellOrderId: orderId }).lean();
  const bankPayout = await post("/digital-metals/payouts", bearerFor(owner), { payableId: payable._id });
  assert.equal(bankPayout.status, 409);
  assert.equal(bankPayout.body.error?.code, "CASH_PAYOUT_ORDER");

  const paid = await post(`/digital-metals/sell-orders/${orderId}/cash-payout`, token, { receiptNote: "Paid at counter" });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.data.payable.status, "SETTLED");
  assert.equal(paid.body.data.payable.settlementMethod, "CASH");
  const debit = await CashAdjustment.findOne({ tenantId: tenant._id, staffId: manager._id, direction: "DEBIT" }).lean();
  assert.equal(debit.amountPaise, payable.amountPaise);

  const again = await post(`/digital-metals/sell-orders/${orderId}/cash-payout`, token, {});
  assert.equal(again.status, 200);
  assert.equal(again.body.data.alreadyPaid, true);
  assert.equal(await CashAdjustment.countDocuments({ tenantId: tenant._id, direction: "DEBIT" }), 1);
});

test("counter sell by bank transfer needs a verified account", async () => {
  const { tenant, owner, customer } = await digitalGoldReady();
  await withTransaction((session) =>
    creditWalletForTest(session, {
      tenantId: tenant._id,
      customerId: customer._id,
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: UG_PER_G,
      idempotencyKey: `seed-${randomUUID()}`,
    }),
  );
  const token = bearerFor(owner);
  const quote = await post(`/digital-metals/customers/${customer._id}/counter/sell-quote`, token, {
    metal: "GOLD",
    finenessPpm: 999_000,
    quantityUg: UG_PER_G,
  });
  const missing = await post(`/digital-metals/customers/${customer._id}/counter/sell`, token, {
    quoteId: quote.body.data.quoteId,
    payoutMethod: "BANK",
    customerConsent: true,
  });
  assert.equal(missing.status, 400);
  const dest = await DigitalMetalBankDestination.create({
    _id: createId("dmbd"),
    tenantId: tenant._id,
    customerId: customer._id,
    accountHolderName: "Test User",
    accountNumberSealed: seal("123456789012"),
    accountLast4: "9012",
    ifsc: "HDFC0001234",
    status: "ACTIVE",
    verifiedAt: new Date(),
  });
  const sell = await post(`/digital-metals/customers/${customer._id}/counter/sell`, token, {
    quoteId: quote.body.data.quoteId,
    payoutMethod: "BANK",
    bankDestinationId: dest._id,
    customerConsent: true,
  });
  assert.equal(sell.status, 201, JSON.stringify(sell.body));
  const order = await DigitalMetalSellOrder.findById(sell.body.data.order.id).lean();
  assert.equal(order.status, "PENDING_APPROVAL");
  assert.equal(order.bankDestinationId, dest._id);
  assert.equal(order.assisted.byUserId, owner._id);
});

test("branch staff cannot trade, and managers are limited to their branch", async () => {
  const { tenant, branch, customer } = await digitalGoldReady();
  const staff = await seedStaff({ tenant, branch, role: TenantRole.BRANCH_STAFF });
  const denied = await post(`/digital-metals/customers/${customer._id}/counter/buy-quote`, bearerFor(staff), {
    metal: "GOLD",
    finenessPpm: 999_000,
    inputMode: "QUANTITY_UG",
    quantityUg: UG_PER_G,
  });
  assert.equal(denied.status, 403);

  const other = await seedBranch({ tenantId: tenant._id });
  const otherManager = await seedStaff({ tenant, branch: other, role: TenantRole.BRANCH_MANAGER });
  const outOfScope = await post(`/digital-metals/customers/${customer._id}/counter/buy-quote`, bearerFor(otherManager), {
    metal: "GOLD",
    finenessPpm: 999_000,
    inputMode: "QUANTITY_UG",
    quantityUg: UG_PER_G,
  });
  assert.ok([403, 404].includes(outOfScope.status), JSON.stringify(outOfScope.body));
});

async function storeReady() {
  const { tenant, branch, user: owner } = await seedTenantUser({});
  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot": { ecommerce: true },
        "subscription.tier": PlanTier.PRO,
        "operations.ecommerceEnabled": true,
      },
    },
  );
  const svcReq = {
    auth: { tenantId: tenant._id, id: owner._id },
    tenant: { ...tenant.toObject(), subscription: { planFeaturesSnapshot: { ecommerce: true } } },
  };
  await ecommerce.putTaxSettings({ ...svcReq, body: taxReadyCatalogBody() });
  const product = await ecommerce.createProduct({
    ...svcReq,
    body: {
      name: "Bangle",
      slug: "bangle",
      priceMode: EcommercePriceMode.FIXED,
      fixedPricing: { basePricePaise: 100_000 },
      taxClassification: "GST_3",
    },
  });
  await ecommerce.publishProduct({ ...svcReq, params: { productId: product.id }, body: { expectedVersion: 1 } });
  const ownerToken = bearerFor(owner);
  await request(app)
    .patch(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set({ authorization: `Bearer ${ownerToken}`, "x-idempotency-key": randomUUID() })
    .send({ stockPolicy: EcommerceStockPolicy.QUANTITY_TRACKED, quantityOnHand: 3 });
  await request(app)
    .put("/api/v1/admin/ecommerce/fulfilment-settings")
    .set({ authorization: `Bearer ${ownerToken}`, "x-idempotency-key": randomUUID() })
    .send(taxReadyFulfilmentBody(branch._id));
  const manager = await seedStaff({ tenant, branch, role: TenantRole.BRANCH_MANAGER });
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  return { tenant, branch, owner, manager, customer, product };
}

test("branch manager places a store order paid in cash at the counter (no online gateway needed)", async () => {
  const { tenant, branch, manager, customer, product } = await storeReady();
  const token = bearerFor(manager);
  const options = await request(app)
    .get(`/api/v1/admin/customers/${customer._id}/ecommerce/counter/options`)
    .set("Authorization", `Bearer ${token}`);
  assert.equal(options.status, 200, JSON.stringify(options.body));
  assert.equal(options.body.data.defaultPickupBranchId, branch._id);
  assert.equal(options.body.data.checkoutTaxReady, true);

  const quote = await post(`/customers/${customer._id}/ecommerce/counter/quote`, token, {
    lines: [{ productId: product.id, quantity: 2 }],
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
    pickupBranchId: branch._id,
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  assert.ok(quote.body.data.totalPaise > 0);

  const order = await post(`/customers/${customer._id}/ecommerce/counter/orders`, token, {
    quoteId: quote.body.data.id,
    paymentMode: "CASH",
    customerConsent: true,
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  assert.equal(order.body.data.order.status, "PAID");
  assert.equal(order.body.data.order.channel, "COUNTER");
  assert.equal(order.body.data.cashCustody, "STAFF");

  const row = await EcommerceOrder.findById(order.body.data.order.id).lean();
  assert.equal(row.customerId, customer._id);
  assert.equal(row.assisted.paymentMode, "CASH");
  const cash = await CashAdjustment.findOne({ tenantId: tenant._id, sourceId: row._id }).lean();
  assert.equal(cash.amountPaise, row.totalPaise);

  const inv = await request(app)
    .get(`/api/v1/admin/ecommerce/inventory/${product.id}`)
    .set("Authorization", `Bearer ${token}`);
  assert.equal(inv.body.data.availableQuantity, 1);
});

test("store counter order by card needs the slip number", async () => {
  const { branch, owner, customer, product } = await storeReady();
  const token = bearerFor(owner);
  const quote = await post(`/customers/${customer._id}/ecommerce/counter/quote`, token, {
    lines: [{ productId: product.id, quantity: 1 }],
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
    pickupBranchId: branch._id,
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const missing = await post(`/customers/${customer._id}/ecommerce/counter/orders`, token, {
    quoteId: quote.body.data.id,
    paymentMode: "CARD",
    customerConsent: true,
  });
  assert.equal(missing.status, 400);
  const card = await post(`/customers/${customer._id}/ecommerce/counter/orders`, token, {
    quoteId: quote.body.data.id,
    paymentMode: "CARD",
    paymentReference: "APPR-55821",
    customerConsent: true,
  });
  assert.equal(card.status, 201, JSON.stringify(card.body));
  assert.equal(card.body.data.order.status, "PAID");
  assert.equal(card.body.data.cashCustody, null);
});

test("customer and dashboard Digi Gold summaries reflect counter trades; store summary counts counter orders", async () => {
  const { manager, owner, customer } = await digitalGoldReady();
  const token = bearerFor(manager);
  const quote = await post(`/digital-metals/customers/${customer._id}/counter/buy-quote`, token, {
    metal: "GOLD",
    finenessPpm: 999_000,
    inputMode: "QUANTITY_UG",
    quantityUg: 2 * UG_PER_G,
  });
  const buy = await post(`/digital-metals/customers/${customer._id}/counter/buy`, token, {
    quoteId: quote.body.data.quoteId,
    paymentMode: "CASH",
    customerConsent: true,
  });
  assert.equal(buy.status, 201, JSON.stringify(buy.body));

  const summary = await request(app)
    .get(`/api/v1/admin/digital-metals/customers/${customer._id}/summary`)
    .set("Authorization", `Bearer ${token}`);
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.data.totals.goldUg, String(2 * UG_PER_G));
  assert.equal(summary.body.data.totals.valuePaise, 1_200_000);
  assert.equal(summary.body.data.bought.count, 1);
  assert.equal(summary.body.data.bought.counterCount, 1);

  const dash = await request(app)
    .get("/api/v1/admin/digital-metals/dashboard-summary?period=THIS_MONTH")
    .set("Authorization", `Bearer ${bearerFor(owner)}`);
  assert.equal(dash.status, 200, JSON.stringify(dash.body));
  assert.equal(dash.body.data.totals.customersHolding, 1);
  assert.equal(dash.body.data.buys.count, 1);
  assert.equal(dash.body.data.buys.counterCount, 1);
  assert.equal(dash.body.data.newInvestors, 1);
  assert.equal(dash.body.data.trend.length, 14);
  assert.ok(dash.body.data.trend.at(-1).buyPaise > 0);
});

test("customer store summary includes counter orders", async () => {
  const { branch, owner, customer, product } = await storeReady();
  const token = bearerFor(owner);
  const quote = await post(`/customers/${customer._id}/ecommerce/counter/quote`, token, {
    lines: [{ productId: product.id, quantity: 1 }],
    fulfilmentMode: EcommerceFulfilmentMode.BRANCH_PICKUP,
    pickupBranchId: branch._id,
  });
  await post(`/customers/${customer._id}/ecommerce/counter/orders`, token, {
    quoteId: quote.body.data.id,
    paymentMode: "CASH",
    customerConsent: true,
  });
  const res = await request(app)
    .get(`/api/v1/admin/customers/${customer._id}/ecommerce/summary`)
    .set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.orderCount, 1);
  assert.equal(res.body.data.openOrders, 1);
  assert.equal(res.body.data.itemsBought, 1);
  assert.equal(res.body.data.counterOrders.count, 1);
  assert.equal(res.body.data.lastOrder.status, "PAID");
});
