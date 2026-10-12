# Ecommerce activation checklist (current `ecommerce` branches)

API addendum (routes, returns, outbox): [ECOMMERCE_API_CONTRACT.md](./ECOMMERCE_API_CONTRACT.md)

**Purpose:** Separate **code/test gates** from **business approval**, **PhonePe sandbox evidence**, and **deployment** before any live ecommerce payments. This document does **not** authorize production payments.

**Overall production decision:** **NO-GO** until all **Mandatory** gates in §5 are satisfied and product issues a final GO. Enabling production rollout flags is the **last** controlled action (§5.1), not a prerequisite for other gates.

---

## Source control and reproducibility

Engineering evidence must be tied to **what was tested**. Until Phase E is committed on both repos, treat code gates as **provisional**, not a reproducible release PASS.

### Working tree (local, 2026-10-09)

| Repository | Branch | HEAD at doc time | Working tree | Tests reflect |
|------------|--------|------------------|--------------|---------------|
| `swarnagrow-backend` | `ecommerce` | `b58161596087afa752bf57d17d305b7ce056d1f5` | **Dirty** — Phase E changes uncommitted on top of HEAD | **Uncommitted tree** + local commands below |
| `SwarnaGrow-Tenant-Admin` | `ecommerce` | `54b72790c45168e71827a29e410f36d8bb8c21db` | **Dirty** — Phase E UI uncommitted on top of HEAD | Same |

After Phase E is committed, **replace this block** with:

| Field | Backend | Tenant Admin |
|-------|---------|--------------|
| Release commit (immutable) | _record full SHA_ | _record full SHA_ |
| Working tree at verification | `clean` (`git status --porcelain` empty) | `clean` |
| Tag or release name (optional) | _e.g. `ecommerce-phase-e-rc1`_ | _same tag if monorepo process applies_ |

### Immutable verification (required for release PASS)

| Field | Value |
|-------|--------|
| CI workflow / job | _e.g. GitHub Actions `ci.yml` on `ecommerce` — **link TBD after pipeline run**_ |
| Fresh checkout command | `git fetch && git checkout <release-sha> && npm ci && npm test` |
| Retained log artifact | _Attach CI job log or upload to release assets — **do not rely on `/tmp`**_ |
| Local placeholder (supersede) | Provisional run only: engineer machine, 2026-10-09; summary counts below until CI artifact exists |

**Rule:** §1 engineering rows stay **PROVISIONAL PASS** until a **clean checkout at the release commit** (or CI on that commit) reproduces the same results and the artifact link is filled in §1.1.

---

## Environment-specific activation (staging vs production)

| Environment | Platform `ECOMMERCE_PAYMENTS_ROLLOUT_ENABLED` | Tenant `ecommercePaymentsRolloutEnabled` | PhonePe | Customer impact |
|-------------|-----------------------------------------------|------------------------------------------|---------|-----------------|
| **Production** | **OFF** until final GO (§5) | **OFF** until final GO | Live credentials only after GO | Real money |
| **Staging (sandbox checklist only)** | May be **ON on staging API only** with written ops approval | May be **ON for one sandbox pilot tenant only** | **Sandbox** credentials (`environment: SANDBOX`) | Test customers / staff only |

**Staging isolation**

- Dedicated staging API host and MongoDB (no production DB).
- Single pilot tenant code; no production tenant IDs or secrets.
- `PROVIDER_MODE=live` (or non-mock) with PhonePe **sandbox** keys only on that tenant.
- Webhook URL points at staging host: `POST /api/v1/webhooks/phonepe/:tenantId`.
- Plan feature `ecommercePayments: true` only on pilot tenant for the exercise.

**Reset after sandbox checklist (mandatory before any prod discussion)**

1. Set tenant `operations.ecommercePaymentsRolloutEnabled=false`.
2. Set platform staging `ECOMMERCE_PAYMENTS_ROLLOUT_ENABLED=false` (or remove staging override entirely).
3. Revoke or rotate sandbox webhook credentials if exposed during testing.
4. Archive redacted evidence in §3; mark staging tenant orders as test data.

Production platform and tenant rollout flags remain **OFF** until final GO, regardless of staging activity.

**Not valid for sandbox gate:** `PROVIDER_MODE=mock`, `ECOMMERCE_PAYMENTS_TEST_HARNESS` (test-only), or automated mock HTTP tests alone.

---

## 1. Code gates

Status key: **PROVISIONAL PASS** = observed locally on dirty tree; **RELEASE PASS** = clean checkout or CI at release commit with retained artifact.

### 1.1 Full backend test suite

| Field | Value |
|-------|--------|
| Command | `cd swarnagrow-backend && npm test` |
| Provisional result (dirty tree, 2026-10-09) | **1349** total · **1347** pass · **0** fail · **2** skip |
| Duration (provisional) | ~59 min (`--test-concurrency=1`) |
| Node reporter (provisional) | `ℹ tests 1349` / `ℹ pass 1347` / `ℹ fail 0` / `ℹ skipped 2` / `ℹ duration_ms 3524412` |
| Retained artifact / CI | **TBD** — paste URL or release asset path here when available |
| Gate status | **PROVISIONAL PASS** (0 fail on local dirty tree) · **RELEASE PASS blocked** until artifact + release SHA |

**Skipped tests (2) — explicit, Redis-conditional**

| Test file | Test name | Skip condition |
|-----------|-----------|----------------|
| `tests/security-rate-limit.test.js` | `teardown clears rate-limit stores without late Redis commands after disconnect` | `t.skip("Redis not available")` when Redis probe or `connectRedis()` fails |
| `tests/security-rate-limit.test.js` | `redis-backed stores with distinct prefixes increment independently` | Same |

These skips are **environment-dependent**, not ecommerce-specific. They were **not executed** in the provisional run. Do **not** count them as pass or fail; record skip count as **2** until a run with Redis actually executes them.

### 1.2 Backend static checks

| Command | Provisional (dirty tree) | Release PASS |
|---------|--------------------------|--------------|
| `npm run check` | PASS (2026-10-09 local) | TBD at release SHA + CI |

### 1.3 Focused ecommerce HTTP tests (17)

| Command | Provisional (dirty tree) |
|---------|--------------------------|
| `node --test tests/ecommerce-commerce-phase-e-http.test.js tests/ecommerce-commerce-phase-d2-hardening-http.test.js tests/ecommerce-commerce-phase-d2-http.test.js` | **17/17 pass** (2026-10-09) |

Coverage includes: webhook 401 without state mutation; signed payment/refund via HTTP `/api/v1/webhooks/phonepe/:tenantId`; downgrade after INITIATED; refund confirm/duplicate; customer refund presentation; operator reconcile retry; payment exception queue.

Release PASS: same command at release commit with artifact reference in §1.1.

### 1.4 Tenant Admin frontend gates

| Command | Provisional (dirty tree) |
|---------|--------------------------|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` (Vitest) | 33 pass |
| `npm run build` | PASS |

---

## 2. Product / accountant approval

**Mandatory for production GO.** Each row needs owner, approval date, and artifact (email, signed PDF, ticket). Until recorded: **BLOCKED**.

| Item | Owner | Approval date | Evidence | Status |
|------|-------|---------------|----------|--------|
| Seller legal name, GSTIN, registered state on fulfilment/tax config | Accountant / tenant owner | — | — | **BLOCKED** |
| HSN/SAC mappings per product category | Accountant | — | — | **BLOCKED** |
| Place-of-supply rules (default + delivery vs pickup) | Accountant | — | — | **BLOCKED** |
| Intra-state vs inter-state component tax lines (no auto CGST/SGST/IGST split in app) | Accountant | — | — | **BLOCKED** |
| Delivery: serviceable pincodes, delivery charge, fulfilment modes | Product / ops | — | — | **BLOCKED** |
| Invoice / receipt wording for ecommerce orders | Accountant / legal | — | — | **BLOCKED** |
| Refund policy (late-success exception, provider pending vs confirmed) | Product / legal | — | — | **BLOCKED** |
| Cancellation policy (pending payment vs paid) | Product / legal | — | — | **BLOCKED** |
| Sign-off that `checkoutTaxReady` + accountant component presentation is production-accurate | Accountant | — | — | **BLOCKED** |

---

## 3. PhonePe sandbox gate

**Mandatory for production GO.** Entire section **BLOCKED** until executed with **real PhonePe sandbox** credentials on an **isolated staging** tenant (see staging table above). Mock tests do **not** satisfy this gate.

Script: `docs/ECOMMERCE_PHONEPE_STAGING_CHECKLIST.md`. Record **redacted** IDs only (no secrets).

| Scenario | Redacted IDs | Result | Status |
|----------|--------------|--------|--------|
| Payment initiation (SDK order / redirect) | `merchantOrderId` `epay_…` | — | **BLOCKED** |
| Signed `CHECKOUT_ORDER_COMPLETED` webhook | `whk_…`, `transactionId` | — | **BLOCKED** |
| Status poll / `ecommerce-payment-reconcile` job | `providerOrderId` | — | **BLOCKED** |
| Terminal failure / expiry (no false PAID) | — | — | **BLOCKED** |
| Late success after expiry → exception refund | `eord_…`, `epayref_…` | — | **BLOCKED** |
| Signed refund webhook `PG_REFUND_COMPLETED` | `providerRefundId` | — | **BLOCKED** |
| Duplicate payment + refund callbacks | replay same IDs | — | **BLOCKED** |
| Staff fulfilment after verified PAID | `orderId`, `expectedVersion` | — | **BLOCKED** |

After completion: perform **staging reset** (see *Environment-specific activation* above) before treating sandbox as done.

---

## 4. Deployment and operations

**Mandatory for production GO** (pilot row may complete in staging first).

| Item | Reference / action | Status |
|------|-------------------|--------|
| Mongo indexes (commerce models, `providerRefundId`, payment attempts) | Deploy backend; index sync per `OPERATIONS.md` | **PENDING** |
| Schema / models deployed | `EcommerceOrder`, `EcommercePaymentAttempt`, `EcommercePaymentExceptionRefund`, outbox topics | **PENDING** |
| Scheduler `ecommerce-payment-reconcile` | `src/schedulers/repeatable-jobs.js` (~120s) | **PENDING** |
| Worker `processWebhook` (ecommerce payment + refund) | BullMQ `webhooks` queue | **PENDING** |
| Webhook URL registered (staging then prod) | `POST /api/v1/webhooks/phonepe/:tenantId` | **BLOCKED** |
| Webhook auth configured | Tenant `webhookUsername` / `webhookPassword` | **BLOCKED** |
| Secrets sealed (not in repo) | PhonePe client credentials | **BLOCKED** |
| Monitoring | Payment exceptions queue; `PAYMENT_REVIEW` alerts; stuck attempts | **PENDING** |
| Rollback drill documented | Flags off; in-flight webhook/reconcile continues | **PENDING** |
| Single-tenant pilot (non-prod first) | One jeweller; staff trained on exception queue | **BLOCKED** |

---

## 5. GO / NO-GO summary

**Mandatory:** Yes = must reach **PASS** (or documented **PASS with note**) before **production** ecommerce payments. **Final action** = executed only after all other Mandatory rows pass and product signs GO.

| Gate | Mandatory | Owner | Evidence | Status |
|------|-----------|-------|----------|--------|
| Full backend `npm test` (0 fail; skips documented) | Yes | Engineering | CI artifact or release log (§1.1); 2 Redis skips explicit | **PROVISIONAL PASS** / **RELEASE PASS TBD** |
| Backend `npm run check` | Yes | Engineering | CI or clean checkout at release SHA | **PROVISIONAL PASS** / **RELEASE PASS TBD** |
| Ecommerce focused HTTP (17) | Yes | Engineering | Same commit as release | **PROVISIONAL PASS** / **RELEASE PASS TBD** |
| Frontend typecheck, lint, vitest, build | Yes | Engineering | Same commit as release | **PROVISIONAL PASS** / **RELEASE PASS TBD** |
| Accountant & product approval (§2) | Yes | Accountant + Product | Signed artifacts | **NO-GO (BLOCKED)** |
| PhonePe sandbox evidence (§3) | Yes | Engineering + Ops | §3 table + staging reset | **NO-GO (BLOCKED)** |
| Deployment & webhook (§4) | Yes | Ops / SRE | Staging then prod checklist | **NO-GO (PENDING/BLOCKED)** |
| **Final:** Enable **production** platform rollout flag | Final action | Product | Written GO referencing this doc revision | **OFF — do not enable** |
| **Final:** Enable **production** tenant rollout flag | Final action | Product + tenant owner | Same GO; pilot tenant only | **OFF — do not enable** |

§5.1 **Final controlled actions (after all Mandatory PASS + product GO)**

1. Confirm production decision **GO** in writing (not implied by staging work).
2. Set production `ECOMMERCE_PAYMENTS_ROLLOUT_ENABLED=true` (platform env).
3. Set pilot tenant `operations.ecommercePaymentsRolloutEnabled=true` and plan `ecommercePayments: true`.
4. Use **live** PhonePe credentials; never reuse sandbox keys in production.
5. Monitor payment exceptions queue for 72h; rollback = flags off per §4.

**Explicit non-goals**

- Do not mark production payments ready from mock or provisional local runs alone.
- Do not enable production rollout flags while updating this document.
- Ecommerce uses `EcommerceOrder` / `EcommercePaymentAttempt`; scheme `Payment` / `PaymentIntent` remain separate.

---

## Revision log

| Date | Author | Change |
|------|--------|--------|
| 2026-10-09 | Engineering | Initial checklist |
| 2026-10-09 | Engineering | Provisional vs release commits; CI artifact; staging-only rollout; Mandatory column; final flag actions |
