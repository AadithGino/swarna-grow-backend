import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/lib/app-error.js";
import { createId } from "../src/lib/ids.js";
import { Customer, Message, Payment } from "../src/models/index.js";
import { shareCustomerStatement } from "../src/services/messaging.service.js";
import { PaymentMode, PaymentSource, PaymentStatus, UserType } from "../src/constants/enums.js";
import { resetTestDb, seedCustomer, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("shareCustomerStatement queues a WhatsApp message with payment summary", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  await Payment.create({
    _id: createId("payment"),
    tenantId: tenant._id,
    branchId: branch._id,
    schemeId: createId("scheme"),
    customerId: customer._id,
    receiptNumber: "RCPT-STMT-1",
    amountPaise: 250000,
    mode: PaymentMode.CASH,
    source: PaymentSource.STAFF_APP,
    status: PaymentStatus.SUCCESS,
    paidAt: new Date("2026-01-10T10:00:00+05:30"),
  });
  const message = await shareCustomerStatement({
    auth: { id: user._id, tenantId: tenant._id, type: UserType.TENANT_USER },
    scope: { tenantId: tenant._id, branchId: branch._id },
    params: { customerId: customer._id },
    headers: { "user-agent": "messaging-statement-test" },
    ip: "127.0.0.1",
  });
  assert.equal(message.type, "CUSTOMER_STATEMENT");
  assert.equal(message.templateKey, "CUSTOMER_STATEMENT");
  assert.equal(message.templateParams.paymentCount, 1);
  assert.equal(message.templateParams.totalDisplay, "₹2,500");
  assert.equal(await Message.countDocuments({ customerId: customer._id, type: "CUSTOMER_STATEMENT" }), 1);
});

test("shareCustomerStatement rejects opted-out customers", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "CUST-OPT-1",
    name: "Opted Out",
    mobile: "+919811155566",
    whatsappOptedOutAt: new Date(),
  });
  await assert.rejects(
    () => shareCustomerStatement({
      auth: { id: user._id, tenantId: tenant._id, type: UserType.TENANT_USER },
      scope: { tenantId: tenant._id, branchId: branch._id },
      params: { customerId: customer._id },
    }),
    (error) => error instanceof AppError && error.code === "WHATSAPP_OPTED_OUT",
  );
});
