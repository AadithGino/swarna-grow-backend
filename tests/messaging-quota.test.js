import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/lib/app-error.js";
import { createId } from "../src/lib/ids.js";
import { Customer, Tenant } from "../src/models/index.js";
import { queueMessage } from "../src/services/messaging.service.js";
import { UserType } from "../src/constants/enums.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("queueMessage enforces monthly WhatsApp quota atomically", async () => {
  const { tenant, branch, user } = await seedTenantUser();
  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { "subscription.limits.whatsappMessages": 1 } },
  );
  const customer = await Customer.create({
    _id: createId("customer"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerNumber: "CUST-WA-1",
    name: "WhatsApp Customer",
    mobile: "+919811133344",
  });
  const req = {
    auth: { id: user._id, tenantId: tenant._id, type: UserType.TENANT_USER },
    scope: { tenantId: tenant._id, branchId: branch._id },
    headers: {},
    ip: "127.0.0.1",
  };
  await queueMessage(req, {
    branchId: branch._id,
    customerId: customer._id,
    type: "PAYMENT_DUE",
    templateKey: "PAYMENT_DUE",
    templateParams: { mobile: customer.mobile },
  });
  await assert.rejects(
    () => queueMessage(req, {
      branchId: branch._id,
      customerId: customer._id,
      type: "PAYMENT_DUE",
      templateKey: "PAYMENT_DUE",
      templateParams: { mobile: customer.mobile },
    }),
    (error) => error instanceof AppError && error.code === "QUOTA_EXCEEDED",
  );
});
