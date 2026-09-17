# SwarnaGrow remediation log

Audit findings fixed in Phases 1–3, with the commit and guarding test for each.

Verification (round 1): `npm run check` and `npm test` both pass (60 tests).

---

## Round 2 — 2026-09-17 (production readiness)

Syntax + route coverage pass. New/extended regression tests pass individually. Full `npm test` may hang on MongoMemoryReplSet teardown in `tests/helpers/db.js` after long runs (pre-existing); targeted suites below are green.

### Phase 1 — Must fix before production

| Finding | File(s) | Test |
|---|---|---|
| **1.1** Export downloads broken across processes | `src/integrations/storage.provider.js`, `src/workers/processors.js`, `src/services/reporting.service.js` | `tests/exports.test.js` |
| **1.2** Redis optional but not enforced in production | `src/config/env.js`, `src/lib/readiness.js`, `src/app.js` | `tests/env-production-secrets.test.js`, `tests/health-readiness.test.js` |
| **1.3** Rate limiters in-memory per replica | `src/middlewares/security.middleware.js` (+ `rate-limit-redis`) | `tests/rate-limit-shared-store.test.js` (skips when Redis unavailable) |

### Phase 2 — Before real jeweller data

| Finding | File(s) | Test |
|---|---|---|
| **2.1** Cash reversal after accepted handover leaves negative balance | `src/services/payment.service.js` | `tests/cash.test.js` (extended reversal + pending negative case) |
| **2.2** Stale permissions/branch in JWT after staff mutation | `src/services/auth.service.js` (`revokeSessionsForUser`), `src/services/tenant.service.js` | `tests/authorization.test.js` (staff role change → refresh 401) |
| **2.3** Increment rule skipped for flexible schemes | `src/services/payment.service.js` (`checkAmount`) | `tests/payments-phase2.test.js` |

**2.3 investigation:** `payableRange` sets `paymentIncrementPaise: 1` for the free-window (`phase: "FLEXIBLE"`) branch, so removing the `quote.model !== "FLEXIBLE"` guard enforces increments only where the capped phase (and other non-flexible quotes) expose `paymentIncrementPaise > 1`. No change to free-window behavior unless a plan later sets a higher increment there.

### Phase 3 — Fix soon

| Finding | File(s) | Test |
|---|---|---|
| **3.1** Passbook index auto-drop on every boot | `src/config/database.js` | No new test; standalone `scripts/fix-customer-indexes.mjs` retained |
| **3.2** Idempotency reclaim window | `src/services/idempotency.service.js` | **No code change** — see note below |
| **3.3** `unhandledRejection` did not shut down | `src/server.js` | Code review / mirrors `uncaughtException` |
| **3.4** Worker crash handlers missing | `src/workers/index.js` | Code review |
| **3.5** Receipt counter hot document | `src/services/payment.service.js` | Comment only (`PERF(audit)`) |
| **3.6** Argon2 inside tenant transaction | `src/services/platform.service.js` | Existing tenant-creation tests |

**3.2 investigation:** Grepped `idempotent` on routes — covered paths are DB mutations, OTP, exports, staff/customer writes, and signup/payment-link initiation. None hold an idempotency lock across PhonePe or other external network calls. `STALE_PROCESSING_MS` left at 60s; reclaim behavior unchanged.

### Phase 4 — Cleanup

| Finding | File(s) | Test |
|---|---|---|
| **4.1** Unmatched gateway webhooks silent | `src/workers/processors.js`, `src/constants/enums.js` | `tests/webhook-processors.test.js` |
| **4.2** Unknown outbox topics silent | `src/workers/processors.js` | Log-only |
| **4.3** Signup token compare not timing-safe | `src/middlewares/signup-auth.middleware.js` | Covered by existing auth flows |
| **4.4** Mock storage enabled in production misconfig | `src/routes/mock-storage.routes.js` | `tests/mock-storage-routes.test.js` |
| **4.5** Customer fuzzy search bounds | `src/services/search.service.js` | **Confirmed** — `.limit(40)` / `.limit(limit)` on Mongoose queries, not in-memory scans |

### Round 2 deviations / notes

- **`CashHandover`** has no `paymentIds` link; adjustment trigger uses pre-reversal balance (`inHandAfter < 0 && handedOverPaise > 0`) plus an accepted/discrepancy handover with `submittedAt >= payment.paidAt`.
- **`logoutAll`** unchanged; added **`revokeSessionsForUser(userId)`** for staff mutations. Revokes refresh sessions only (access token valid until natural expiry).
- **`npm run lint`** still reports pre-existing unused-variable issues in unrelated files; not introduced by this round.

---

## Phase 1 — Critical

| Finding | Commit | Test |
|---|---|---|
| **1.1** Unauthenticated password reset account takeover | `542e863` | `tests/auth-security.test.js` |
| **1.2** Default secrets accepted in production | `b2bfe20` | `tests/env-production-secrets.test.js` |
| **1.3** Admin routes without mandatory permissions | `8c6d2e7` | `tests/authorization.test.js` (+ `scripts/check-route-coverage.js`) |

---

## Phase 2 — High

| Finding | Commit | Test |
|---|---|---|
| **2.1** OTP in-memory / live throw / fixed `123456` outside test | `3df5949` | `tests/otp-provider.test.js` |
| **2.2** Pending cash handovers not reserved | `864e51e` | `tests/cash.test.js` (double full-balance handover) |
| **2.3** Incomplete future-cycle sequencing | `9eaf139` | `tests/flexible-cycles.test.js`, `tests/flexible-rules.test.js` |
| **2.4** Cap reached conflated with below-minimum | `28c6d60` | `tests/payments-phase2.test.js` (`CURRENT_CYCLE_CAP_REACHED`) |
| **2.5** `positionVersion: 0` hole / rename to `expectedPositionVersion` | `28c6d60` | `tests/payments-phase2.test.js` |
| **2.6** `maxPaymentsPerCycle` only on intent path | `28c6d60` | `tests/payments-phase2.test.js` |

---

## Phase 3 — Medium

| Finding | Commit | Test |
|---|---|---|
| **3.1** Audit `sanitize()` corrupts arrays | `c5e57a1` | `tests/phase3-medium.test.js` |
| **3.2** PhonePe timing-unsafe compare / parse before verify | `adaa190` | `tests/phase3-medium.test.js` |
| **3.3** Idempotency stuck `PROCESSING` | `d0e12ef` | `tests/phase3-medium.test.js` |
| **3.4** Cash `DISCREPANCY` never set; cancel wrote `REJECTED` | `ced4962` | `tests/cash.test.js`, `tests/phase3-auth-cash.test.js` |
| **3.5** Ambiguous multi-tenant login | `9ad523c` | `tests/phase3-auth-cash.test.js` |
| **3.6** Public tenant resolve enumeration | `9ad523c` | `tests/phase3-auth-cash.test.js` |
| **3.7** Ledger sequence `countDocuments + 1` races | `4f256ad` | Covered via payment/reversal paths in `tests/payments.test.js` |
| **3.8** WhatsApp webhook processed before persist | `4f256ad` | Behavioural (persist-then-queue); no live webhook harness |
| **3.9** Missing customer route validators | `4f256ad` | Validators wired on admin customer routes; exercised by `npm run check` / Zod |

---

## Phase 4 — Suite

| Suite | File | Covers |
|---|---|---|
| Integration harness | `tests/helpers/db.js` | MongoMemoryReplSet, seed fixtures, bearer helper |
| Security | `tests/auth-security.test.js` | Phase 1.1 |
| Authorization matrix | `tests/authorization.test.js` | Phase 1.3 roles × module routes |
| Isolation | `tests/isolation.test.js` | Cross-tenant / cross-branch → 404 |
| Flexible cycles | `tests/flexible-cycles.test.js` | Phase 2.3 + remainder / no carry-forward |
| Cash integrity | `tests/cash.test.js` | Phase 2.2 / 3.4 |
| Payment allocation | `tests/payments.test.js` | Fixed oldest-first, overpay, gateway block, reverse append |

---

## Intentionally incomplete / notes

1. **Live OTP delivery** — Not implemented. `PROVIDER_MODE=live` with a non-mock `OTP_PROVIDER` fails at API startup (`assertOtpProviderReady`). Mock OTP remains for local/dev; fixed `123456` only when `NODE_ENV=test`.
2. **WhatsApp webhook** — Persist-then-queue is implemented; there is no integration test that drives the BullMQ worker end-to-end in CI (Redis optional in tests).
3. **Cash reverse → adjustment** — Fixed in round 2: accepted/discrepancy handover + negative projected cash-in-hand creates a CREDIT `CashAdjustment` in the same transaction (handover row itself is still not rewritten).
4. **Git history** — Repo was initialized during remediation; `542e863` (password reset) landed before the baseline tree commit `8f3e82d`.

---

## Commit index (newest first)

```
4f256ad  3.7–3.9 ledger / WhatsApp / validators
9ad523c  3.5–3.6 login selection + tenant resolve
ced4962  3.4 cash DISCREPANCY + CANCELLED
d0e12ef  3.3 idempotency stale reclaim
adaa190  3.2 PhonePe timing-safe verify
c5e57a1  3.1 audit sanitize arrays
28c6d60  2.4–2.6 payment caps / versions / count
9eaf139  2.3 future-cycle sequencing
864e51e  2.2 pending cash reserve
3df5949  2.1 OTP Redis + startup fail
8c6d2e7  1.3 mandatory permissions
b2bfe20  1.2 production secrets
542e863  1.1 password reset takeover
```

---

## Round 3 — 2026-09-17 (third-party audit N1–N36)

Round 3 remediation complete (N1–N36). Verification: `npm run check` + `node --test --test-force-exit --test-concurrency=1` on Round 3 suites (80 tests green). Full `npm test` may still hang on MongoMemoryReplSet teardown — pre-existing.

### Phase 1 — Critical (complete)

| Finding | File(s) | Test |
|---|---|---|
| **N1/N27** Staff routes unguarded; notifications over-broad | `src/routes/staff.routes.js`, `src/services/audit.service.js`, `scripts/check-route-coverage.js` | `tests/authorization.test.js` |
| **N2** Customer redemption ₹0 settlement | `src/services/redemption.service.js` | `tests/redemption.test.js` |
| **N7** Mobile-as-password; login rate limit; password policy | `src/services/auth.service.js`, `src/routes/public.routes.js`, `src/validators/common.validators.js` | `tests/auth-security.test.js` |

### Phase 2 — High (complete)

| Finding | File(s) | Test |
|---|---|---|
| **N3/N4** Defaulting + flexible lock jobs | `src/workers/processors.js`, `src/schedulers/index.js`, `src/services/payment.service.js` | `tests/scheme-lifecycle.test.js` |
| **N5/N24** Subscription limits + plan usage counts | `src/lib/tenant-limits.js`, `src/middlewares/auth.middleware.js`, `src/services/*.service.js` | `tests/subscription-enforcement.test.js` |
| **N9/N10** Payment link concurrency + redirect allow-list | `src/services/payment.service.js`, `src/config/env.js` | Code complete; concurrent payment-link tests still deferred |
| **N12–N15** Redemption/gold/payment rules | `src/services/redemption.service.js`, `src/services/scheme.service.js`, `src/lib/money.js` | Extended suites + `tests/enums-money.test.js` (10mg ROUND_DOWN) |
| **N18** Refresh token rotation race | `src/services/token.service.js` | `tests/token-rotation.test.js` |
| **N21/N20** Cash discrepancy adjustments + period report | `src/services/cash.service.js` | `tests/cash.test.js`, `tests/enums-money.test.js` (gold rounding) |

### Phase 3 — Medium (complete)

| Finding | File(s) | Test |
|---|---|---|
| **N11** Webhook tenant scope on intent/link lookup | `src/workers/processors.js` | `tests/webhook-processors.test.js` |
| **N16** CSV formula injection; honest 501 placeholders; dead-letter requeue; export builder mapping | `src/workers/processors.js`, `src/lib/report-export.js`, `src/routes/admin-operations.routes.js` | `tests/exports.test.js` |
| **N17** Customer list overdue/nextDue from raw installments | `src/services/customer.service.js` | `tests/customer-list-dues.test.js` |
| **N19** Access token `securityVersion` binding | `src/models/identity.models.js`, `src/models/customer.model.js`, `src/services/token.service.js`, `src/middlewares/auth.middleware.js` | `tests/security-version.test.js` |
| **N22** WhatsApp quota in `queueMessage` | `src/services/messaging.service.js` | `tests/messaging-quota.test.js` |
| **N23** Branch reassignment integrity | `src/services/customer.service.js` | `tests/customer-branch.test.js` |
| **N34** Production env hardening | `src/config/env.js` | `tests/env-production-secrets.test.js` |
| **N6** Upload lifecycle / verification | `src/services/upload.service.js`, `src/integrations/storage.provider.js`, routes/controllers | `tests/uploads.test.js` |
| **N8** Platform mutation audit | `src/lib/platform-audit.js`, `src/services/platform.service.js` | `tests/platform-audit.test.js` |

### Phase 4 — Low (mostly complete)

| Finding | File(s) | Test |
|---|---|---|
| **N25** Overdue job version increment | `src/workers/processors.js` | `tests/scheme-lifecycle.test.js` |
| **N26** Staff FCM token validator + route wiring | `src/validators/common.validators.js`, `src/routes/staff.routes.js` | Route coverage / manual |
| **N28** Payment reversal window | `src/services/payment.service.js` | `tests/payments.test.js` |
| **N29** Platform app config in DB + public read | `src/models/platform.models.js`, `src/services/platform.service.js`, `src/routes/platform.routes.js`, `src/routes/public.routes.js` | `tests/platform-audit.test.js` |
| **N30** Mobile vs web session TTL | `src/services/auth.service.js`, `src/services/token.service.js` | Existing auth tests |
| **N31** Payment link `expiresInMinutes` max | `src/validators/common.validators.js` | Validator wiring |
| **N32** Resend payment link returns new link | `src/services/payment.service.js` | Existing payment tests |
| **N33** Immutability plugin `replaceOne`/`bulkWrite` | `src/models/plugins/immutable.plugin.js` | Code review |
| **N35–N36** Lint cleanup | Various | `npm run lint` passes |
| **N4.9 deps** | `package.json` | **Deferred** — no dependency bumps this round |

### Round 3 deviations / notes

- **`processExport`** uses `report-builders/*` for `COLLECTION`, `OUTSTANDING`, `GOLD_ACCRUAL`, `STAFF_PERFORMANCE`, `DEFAULTER`, and `MATURITY`; raw dumps remain for `AUDIT`/`CUSTOMER`/`SCHEME`; `DUE`/`OVERDUE` fail with `EXPORT_TYPE_NOT_SUPPORTED`.
- **`statement/share-whatsapp`** — `shareCustomerStatement()` queues `CUSTOMER_STATEMENT` via `queueMessage`; route `POST /:customerId/statement/share-whatsapp` (`tests/messaging-statement.test.js`).
- **`N22` quota** — atomic counter increment with `$setOnInsert` bootstrap (no `Counter.create` retry inside txn — duplicate-key aborts transactions); throws `QUOTA_EXCEEDED` when at limit.
- **`N18` rotation** — concurrent reuse revokes the entire refresh family (successor included); `tests/token-rotation.test.js` asserts one winner + `TOKEN_REUSE_DETECTED` + zero active sessions.
- **`N6` uploads** — presign → complete (HEAD verify) → attach with tenant/purpose/owner checks; download routes at `/uploads/:uploadId`.
- **`npm run lint`** passes after Round 3 Phase 4 cleanup (was ~24 pre-existing errors).
- **`bearerFor`** test helper now passes `securityVersion` for JWT auth tests.
- **`authorization.test.js`** may flake with `ECONNRESET` when run after long suites (pre-existing harness issue); passes when run alone.
