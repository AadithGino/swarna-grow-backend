import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  EcommercePromotionCampaignStatus,
  EcommercePromotionKind,
  PlanTier,
} from "../src/constants/enums.js";
import { Permission } from "../src/constants/permissions.js";
import {
  EcommercePromotionCampaign,
  Tenant,
} from "../src/models/index.js";
import {
  buildEcommerceGoldRateNotificationIntent,
  buildSchemeGoldRateNotificationIntent,
} from "../src/services/gold-rate-notification.service.js";
import {
  isHistoricalEcommerceEffectiveAt,
  isHistoricalSchemeEffectiveDate,
  schemeNotificationScheduledFor,
} from "../src/lib/gold-rate-notification-schedule.js";
import {
  suggestEcommerceGoldRateNotificationCopy,
  suggestSchemeGoldRateNotificationCopy,
} from "../src/lib/gold-rate-notification-copy.js";
import { MessageType } from "../src/constants/enums.js";
import { dispatchPriorityForMessageType } from "../src/lib/message-dispatch-priority.js";
import { withTransaction } from "../src/lib/transaction.js";
import { bearerFor, resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";
import { setCalendarDateOverrideForTests, resetCalendarDateOverrideForTests } from "../src/lib/date.js";

const app = createApp();

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => {
  await resetTestDb();
  resetCalendarDateOverrideForTests();
});

async function enableEcommerce(tenantRow, { storeOn = true } = {}) {
  await Tenant.updateOne(
    { _id: tenantRow._id },
    {
      $set: {
        "subscription.planFeaturesSnapshot": { ecommerce: true },
        "subscription.tier": PlanTier.PRO,
        "operations.ecommerceEnabled": storeOn,
      },
    },
  );
}

test("scheme copy uses 22K and rate display", () => {
  const copy = suggestSchemeGoldRateNotificationCopy({
    ratePerGramPaise: 725_000,
    effectiveDateYmd: "2026-06-15",
  });
  assert.match(copy.title, /22K/);
  assert.match(copy.body, /₹/);
  assert.match(copy.body, /22K/);
});

test("ecommerce copy mentions making charges separately", () => {
  const copy = suggestEcommerceGoldRateNotificationCopy({
    purity: "18K",
    ratePerGramPaise: 600_000,
    effectiveAt: "2026-06-15T10:00:00.000Z",
  });
  assert.match(copy.body, /18K/);
  assert.match(copy.body, /Making charges/i);
});

test("historical scheme effective date skips notification intent", () => {
  setCalendarDateOverrideForTests("2026-06-15");
  assert.equal(isHistoricalSchemeEffectiveDate("2026-06-14"), true);
  const intent = buildSchemeGoldRateNotificationIntent({}, {
    _id: "grt_x",
    effectiveDate: "2026-06-14",
    ratePerGramPaise: 700_000,
    purity: "22K",
    branchId: null,
  });
  assert.equal(intent.skip, true);
  assert.equal(intent.reason, "HISTORICAL_BACKFILL");
});

test("future scheme date schedules notification", () => {
  setCalendarDateOverrideForTests("2026-06-14");
  const scheduled = schemeNotificationScheduledFor("2026-06-15");
  assert.ok(scheduled);
  const intent = buildSchemeGoldRateNotificationIntent({}, {
    _id: "grt_future",
    effectiveDate: "2026-06-15",
    ratePerGramPaise: 700_000,
    purity: "22K",
    branchId: null,
  });
  assert.equal(intent.skip, undefined);
  assert.ok(intent.scheduledFor);
});

test("publish-now ecommerce rate within grace is not historical", () => {
  const now = Date.now();
  assert.equal(isHistoricalEcommerceEffectiveAt(new Date(now - 30_000), now), false);
});

test("gold rate message types are marketing priority", () => {
  assert.ok(
    dispatchPriorityForMessageType(MessageType.PAYMENT_SUCCESS)
      < dispatchPriorityForMessageType(MessageType.SCHEME_GOLD_RATE_UPDATED),
  );
});

test("POST gold-rate without notification creates no campaign", async () => {
  const { tenant: t, user } = await seedTenantUser({});
  const res = await request(app)
    .post("/api/v1/admin/gold-rate")
    .set({
      authorization: `Bearer ${bearerFor(user, [Permission.GOLD_RATE_WRITE])}`,
      "x-idempotency-key": "idem-grt-1",
    })
    .send({
      ratePerGramPaise: 700_000,
      effectiveDate: "2026-06-15",
    });
  assert.equal(res.status, 201);
  const count = await EcommercePromotionCampaign.countDocuments({ tenantId: t._id });
  assert.equal(count, 0);
});

test("POST gold-rate notification without message.send is rejected", async () => {
  const { user } = await seedTenantUser({});
  const res = await request(app)
    .post("/api/v1/admin/gold-rate")
    .set({
      authorization: `Bearer ${bearerFor(user, [Permission.GOLD_RATE_WRITE])}`,
      "x-idempotency-key": "idem-grt-2",
    })
    .send({
      ratePerGramPaise: 700_000,
      effectiveDate: "2026-06-15",
      notification: { enabled: true },
    });
  assert.equal(res.status, 403);
});

test("scheme rate with notification persists durable intent", async () => {
  setCalendarDateOverrideForTests("2026-06-15");
  const { tenant: t, user } = await seedTenantUser({});
  const perms = [Permission.GOLD_RATE_WRITE, Permission.MESSAGE_SEND];
  const res = await request(app)
    .post("/api/v1/admin/gold-rate")
    .set({
      authorization: `Bearer ${bearerFor(user, perms)}`,
      "x-idempotency-key": "idem-grt-3",
    })
    .send({
      ratePerGramPaise: 710_000,
      effectiveDate: "2026-06-15",
      notification: { enabled: true },
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.notification?.intentPersisted, true);
  const campaigns = await EcommercePromotionCampaign.find({ tenantId: t._id }).lean();
  assert.equal(campaigns.length, 1);
  assert.equal(campaigns[0].kind, EcommercePromotionKind.SCHEME_GOLD_RATE);
  assert.equal(campaigns[0].status, EcommercePromotionCampaignStatus.QUEUED);
});

test("transaction rollback removes rate notification intent", async () => {
  setCalendarDateOverrideForTests("2026-06-15");
  const { tenant: t, user } = await seedTenantUser({});
  const reqCtx = {
    auth: { tenantId: t._id, id: user._id, permissions: [Permission.GOLD_RATE_WRITE, Permission.MESSAGE_SEND] },
    body: {
      ratePerGramPaise: 720_000,
      effectiveDate: "2026-06-15",
      purity: "22K",
      notification: { enabled: true },
    },
    scope: { tenantId: t._id },
  };
  try {
    await withTransaction(async (session) => {
      const { assertV1GoldPurity, V1_GOLD_PURITY } = await import("../src/lib/gold-rate-lookup.js");
      assertV1GoldPurity(reqCtx.body.purity);
      const { GoldRate } = await import("../src/models/index.js");
      const { createId } = await import("../src/lib/ids.js");
      const rate = (
        await GoldRate.create(
          [{
            _id: createId("grt"),
            tenantId: t._id,
            branchId: null,
            effectiveDate: reqCtx.body.effectiveDate,
            ratePerGramPaise: reqCtx.body.ratePerGramPaise,
            purity: V1_GOLD_PURITY,
            enteredBy: user._id,
          }],
          { session },
        )
      )[0];
      const { persistRateNotificationIntent, buildSchemeGoldRateNotificationIntent } =
        await import("../src/services/gold-rate-notification.service.js");
      const intent = buildSchemeGoldRateNotificationIntent(reqCtx, rate.toObject());
      await persistRateNotificationIntent(session, reqCtx, intent);
      throw new Error("ROLLBACK");
    });
  } catch (error) {
    assert.equal(error.message, "ROLLBACK");
  }
  assert.equal(await EcommercePromotionCampaign.countDocuments({ tenantId: t._id }), 0);
});

test("ecommerce gold rate notification intent preserves purity", async () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const intent = buildEcommerceGoldRateNotificationIntent({}, {
    _id: "egrt_1",
    purity: "24K",
    ratePerGramPaise: 800_000,
    effectiveAt: new Date(future),
  });
  assert.equal(intent.purity, "24K");
  assert.equal(intent.skip, undefined);
});

test("scheme rate save succeeds when ecommerce store is disabled", async () => {
  setCalendarDateOverrideForTests("2026-06-15");
  const { tenant: t, user } = await seedTenantUser({});
  await enableEcommerce(t, { storeOn: false });
  const perms = [Permission.GOLD_RATE_WRITE, Permission.MESSAGE_SEND];
  const res = await request(app)
    .post("/api/v1/admin/gold-rate")
    .set({
      authorization: `Bearer ${bearerFor(user, perms)}`,
      "x-idempotency-key": "idem-grt-scheme-eco-off",
    })
    .send({
      ratePerGramPaise: 705_000,
      effectiveDate: "2026-06-15",
      notification: { enabled: true },
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.notification?.intentPersisted, true);
});
