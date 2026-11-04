# Prepared fixes (not applied during post-F12 release run)

Apply after the in-flight release exits, then run focused regressions before the next full suite.

## 1. Release gate exit status

**Finding:** Task 708710 logged `exit_code: 0` with 8 failing tests. The command was `node … | tee log` without `pipefail`. Node returns **1** on failure (`/tmp/swarna-exit-probe.test.js` verified). Cursor’s wrapper may report the shell wrapper exit, not Node’s.

**Prepared:** `scripts/run-test-release.sh` (`set -o pipefail` + `exec node …`).

**Follow-up:** Point `package.json` `"test:release"` at `bash scripts/run-test-release.sh` (no args = full suite).

## 2. `tenant isolation on orders list`

**Test:** `tests/ecommerce-admin-workspace-http.test.js:83`

**Assertions:** `200`, `data.length === 1`, `data[0].customerId === a.customer._id`.

**Application path:** JWT → `req.auth.tenantId` → `buildAdminOrderListMongoFilter(tenantId, …)` → `paginate` with `{ tenantId }` scope. No list cache; branch scope not applied on this route.

**Reproduction:** 15× full file, process-isolated file, and predecessor `ecommerce-admin-orders-list-filter.test.js` + workspace file — **all pass**. Single failure at 263 ms in post-F12 log only (no AssertionError block yet).

**Likely cause:** Intermittent empty list or wrong row under memory-server load (not reproduced). Optional hardening (test-only): distinct staff mobiles via `seedFixture({ mobile: … })`, assert `EcommerceOrder.countDocuments({ tenantId: a.tenant._id }) === 1` before HTTP, assert each row’s `tenantId` in response if exposed.

**Latent defect (separate):** `paginate()` merges `filters: normalized` into the Mongo query (`{ …scope, …filters }`), which can add non-schema keys (`q`, `needsAction`, …). Worth fixing to use `scope` only for `find` and `normalized` only for cursor hashing.

## 3. DB lifecycle

**Confirmed:**

- `global-test-db-serial.js`: global `before` → `startTestDb()`; global `after` → `stopTestDb({ force: true })` (final teardown only).
- Per-file `test.after` → `stopTestDb()` without force (refcount −1; **does not** stop replSet).
- Removed `stopTestDb({ force: true })` from `p0-foundation` outbox test (was mid-file teardown); use `resetTestDb()` in `finally`.
- Removed `force: true` from `idempotency-resource-binding.test.js` after hook.

**Note:** `stopTestDb()` without force still clears idempotency heartbeats, rate-limit stores, and `disconnectRedis()` on every file exit — intentional test hygeine; Mongo stays up until global `force`.
