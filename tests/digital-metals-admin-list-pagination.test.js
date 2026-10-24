import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PlanTier, TenantRole } from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { createId } from "../src/lib/ids.js";
import { DigitalMetalPayable, Tenant } from "../src/models/index.js";
import {
  bearerFor,
  resetTestDb,
  seedCustomer,
  seedTenantUser,
  startTestDb,
  stopTestDb,
} from "./helpers/db.js";

const app = createApp();

test.before(async () => {
  await startTestDb();
});
test.after(async () => {
  await stopTestDb();
});
test.beforeEach(async () => {
  await resetTestDb();
});

async function enablePlan(tenantId) {
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

test("admin payables cursor pagination returns >100 rows in order", async () => {
  const { tenant, branch, user } = await seedTenantUser({});
  await enablePlan(tenant._id);
  const customer = await seedCustomer({ tenantId: tenant._id, branchId: branch._id });
  const rows = [];
  for (let i = 0; i < 105; i += 1) {
    rows.push({
      _id: createId("dmpaybl"),
      tenantId: tenant._id,
      customerId: customer._id,
      sellOrderId: createId("dmso"),
      amountPaise: 100_00 + i,
      outstandingPaise: 100_00 + i,
      status: "OPEN",
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    });
  }
  await DigitalMetalPayable.insertMany(rows);

  const token = `Bearer ${bearerFor(user, ROLE_PERMISSIONS[TenantRole.TENANT_OWNER])}`;
  const page1 = await request(app)
    .get("/api/v1/admin/digital-metals/payables")
    .query({ limit: 50 })
    .set("Authorization", token);
  assert.equal(page1.status, 200);
  assert.equal(page1.body.data.items.length, 50);
  assert.equal(page1.body.data.meta.hasMore, true);
  assert.ok(page1.body.data.meta.nextCursor);

  const page2 = await request(app)
    .get("/api/v1/admin/digital-metals/payables")
    .query({ limit: 50, cursor: page1.body.data.meta.nextCursor })
    .set("Authorization", token);
  assert.equal(page2.status, 200);
  assert.equal(page2.body.data.items.length, 50);
  assert.equal(page2.body.data.meta.hasMore, true);

  const page3 = await request(app)
    .get("/api/v1/admin/digital-metals/payables")
    .query({ limit: 50, cursor: page2.body.data.meta.nextCursor })
    .set("Authorization", token);
  assert.equal(page3.status, 200);
  assert.equal(page3.body.data.items.length, 5);
  assert.equal(page3.body.data.meta.hasMore, false);

  const ids = [
    ...page1.body.data.items.map((r) => r.id),
    ...page2.body.data.items.map((r) => r.id),
    ...page3.body.data.items.map((r) => r.id),
  ];
  assert.equal(new Set(ids).size, 105);
  for (let i = 1; i < ids.length; i += 1) {
    assert.ok(ids[i - 1] > ids[i], "expected descending _id cursor order");
  }
});
