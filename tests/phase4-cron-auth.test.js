/**
 * AUD-12: Cron HTTP handlers — auth before boot, no VERCEL bypass, no query secrets.
 */
import test from "node:test";
import assert from "node:assert/strict";

test("assertCronRequestAuthorized: missing secret on Vercel requires config (queue-tick)", async () => {
  const { assertCronRequestAuthorized } = await import("../src/lib/cron-auth.js");
  const prevVercel = process.env.VERCEL;
  const prevNode = process.env.NODE_ENV;
  const prevSecret = process.env.CRON_SECRET;
  try {
    process.env.VERCEL = "1";
    process.env.NODE_ENV = "production";
    delete process.env.CRON_SECRET;
    const r = assertCronRequestAuthorized({ headers: {} }, { requireSecretAlways: true });
    assert.equal(r.ok, false);
    assert.equal(r.statusCode, 503);
    assert.equal(r.body.code, "CRON_SECRET_NOT_CONFIGURED");
  } finally {
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
    if (prevSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevSecret;
  }
});

test("assertCronRequestAuthorized: wrong bearer returns 401", async () => {
  const { assertCronRequestAuthorized } = await import("../src/lib/cron-auth.js");
  process.env.CRON_SECRET = "goodsecret";
  try {
    const r = assertCronRequestAuthorized(
      { headers: { authorization: "Bearer wrong" } },
      { requireSecretAlways: true },
    );
    assert.equal(r.ok, false);
    assert.equal(r.statusCode, 401);
  } finally {
    delete process.env.CRON_SECRET;
  }
});

test("assertCronRequestAuthorized: plain token without Bearer is rejected", async () => {
  const { assertCronRequestAuthorized } = await import("../src/lib/cron-auth.js");
  process.env.CRON_SECRET = "goodsecret";
  try {
    const r = assertCronRequestAuthorized(
      { headers: { authorization: "goodsecret" } },
      { requireSecretAlways: true },
    );
    assert.equal(r.ok, false);
    assert.equal(r.statusCode, 401);
  } finally {
    delete process.env.CRON_SECRET;
  }
});

test("queue-tick: unauthorized returns before boot", async () => {
  const { queueTickHttpHandler } = await import("../api/cron/queue-tick.js");
  let booted = false;
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(s) {
      this.body = typeof s === "string" ? s : JSON.stringify(s);
    },
  };
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "s3";
  try {
    await queueTickHttpHandler(
      { method: "GET", headers: { authorization: "Bearer wrong" } },
      res,
      {
        boot: async () => {
          booted = true;
        },
        tryAcquireCronQueueTickLock: async () => true,
        releaseCronQueueTickLock: async () => {},
        runDispatchCycle: async () => ({}),
        runDigitalMetalOutboxDispatch: async () => ({}),
        runDispatchLeaseReclamation: async () => ({}),
      },
    );
    assert.equal(booted, false);
    assert.equal(res.statusCode, 401);
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  }
});

test("queue-tick: degraded health when subtask fails", async () => {
  const { queueTickHttpHandler } = await import("../api/cron/queue-tick.js");
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(s) {
      this.body = s;
    },
  };
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "cron-test-secret";
  try {
    await queueTickHttpHandler(
      { method: "POST", headers: { authorization: "Bearer cron-test-secret" } },
      res,
      {
        boot: async () => {},
        tryAcquireCronQueueTickLock: async () => true,
        releaseCronQueueTickLock: async () => {},
        runDispatchCycle: async () => ({ error: "boom" }),
        runDigitalMetalOutboxDispatch: async () => ({}),
        runDispatchLeaseReclamation: async () => ({}),
      },
    );
    assert.equal(res.statusCode, 500);
    const j = JSON.parse(res.body);
    assert.equal(j.ok, false);
    assert.equal(j.health, "degraded");
    assert.ok(j.dispatch.error);
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  }
});

test("queue-tick: overlapping invocation skips work", async () => {
  const { queueTickHttpHandler } = await import("../api/cron/queue-tick.js");
  const res = {
    statusCode: 0,
    headers: {},
    setHeader() {},
    end(s) {
      this.body = s;
    },
  };
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "cron-test-secret";
  try {
    await queueTickHttpHandler(
      { method: "GET", headers: { authorization: "Bearer cron-test-secret" } },
      res,
      {
        boot: async () => {},
        tryAcquireCronQueueTickLock: async () => false,
        releaseCronQueueTickLock: async () => {},
        runDispatchCycle: async () => {
          throw new Error("should not run");
        },
        runDigitalMetalOutboxDispatch: async () => ({}),
        runDispatchLeaseReclamation: async () => ({}),
      },
    );
    assert.equal(res.statusCode, 200);
    const j = JSON.parse(res.body);
    assert.equal(j.skipped, true);
    assert.equal(j.reason, "concurrent_tick");
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  }
});

test("queue-tick: authorized path runs maintenance", async () => {
  const { queueTickHttpHandler } = await import("../api/cron/queue-tick.js");
  const res = {
    statusCode: 0,
    headers: {},
    setHeader() {},
    end(s) {
      this.body = s;
    },
  };
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "cron-test-secret";
  let ran = false;
  try {
    await queueTickHttpHandler(
      { method: "GET", headers: { authorization: "Bearer cron-test-secret" } },
      res,
      {
        boot: async () => {},
        tryAcquireCronQueueTickLock: async () => true,
        releaseCronQueueTickLock: async () => {},
        runDispatchCycle: async () => {
          ran = true;
          return {};
        },
        runDigitalMetalOutboxDispatch: async () => ({}),
        runDispatchLeaseReclamation: async () => ({}),
      },
    );
    assert.equal(ran, true);
    assert.equal(res.statusCode, 200);
    const j = JSON.parse(res.body);
    assert.equal(j.ok, true);
    assert.equal(j.health, "ok");
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  }
});

test("keep-warm: production without secret returns 503", async () => {
  const { keepWarmHttpHandler } = await import("../api/cron/keep-warm.js");
  const res = {
    statusCode: 0,
    setHeader() {},
    end(s) {
      this.body = s;
    },
  };
  const pv = process.env.VERCEL;
  const pn = process.env.NODE_ENV;
  const ps = process.env.CRON_SECRET;
  try {
    process.env.VERCEL = "1";
    process.env.NODE_ENV = "production";
    delete process.env.CRON_SECRET;
    await keepWarmHttpHandler({ method: "GET", headers: {} }, res, {
      boot: async () => {
        throw new Error("should not boot");
      },
    });
    assert.equal(res.statusCode, 503);
  } finally {
    if (pv === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = pv;
    if (pn === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = pn;
    if (ps === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ps;
  }
});
