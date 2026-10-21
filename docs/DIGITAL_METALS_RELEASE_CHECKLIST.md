# Digital Metals — Phase 11 release verification checklist

**Verdict (local / automated): BLOCKED** — Harness fixes landed; **`npm run test:release` re-running** on `/tmp/swarna-test-release-2026-10-21T154500Z.log`; browser/visual gates not done. See [Final verdict](#final-verdict). **Not production approval.**

**Recorded:** 2026-10-21T15:45:00Z (UTC) — supersedes any prior PASS on this dirty tree until the new release log finishes.

## Source identity

| Item | Value |
|------|--------|
| Backend path | `/Users/aadithgino/Developer/Swarna Grow/swarnagrow-backend` |
| Portal path | `/Users/aadithgino/Developer/Swarna Grow/SwarnaGrow-Tenant-Admin` |
| Git branch | `ecommerce` (ahead of origin) |
| Git commit (base) | `3df60d8246bc8860e66bcb947f14f907aa070f83` |
| Working tree | **Dirty** (~160+ modified/untracked paths — full Digital Metals + Vercel/worker WIP; not committed) |
| AGENTS.md | Not present at repo root |
| Playbook | `SwarnaGrow_Digital_Metals_Cursor_Playbook.md` (repo root) |

## Phase 10 prerequisite (confirmed in source)

| Fix | Source evidence |
|-----|-----------------|
| Logical PUSH resend retries devices | `prepareDeliveriesForLogicalResend` in `src/services/push-delivery.service.js`, `src/lib/message-logical-resend.js` |
| Replacement shipment notice | `shipmentEventId` + `REPLACEMENT_DISPATCHED` in `digital-metals-redemption-fulfilment.service.js`, `digital-metals-customer-notice.js` |
| ESLint `.mjs` scripts | `eslint.config.js` includes `scripts/**/*.mjs` |

## 1. Automated release gates

| Gate | Command | When (UTC) | Result |
|------|---------|------------|--------|
| Backend syntax + routes + lint | `npm run check` | 2026-10-20 | **Pass** — 840 JS files, **456** contract routes, ESLint clean |
| Digital Metals + harness | `npm test -- tests/digital-metals-*.test.js tests/message-logical-push-resend.test.js tests/route-coverage-digital-metals.test.js` | 2026-10-20 | **154 / 154 pass** (~7m), in-memory Mongo, mock FCM on resend tests |
| Phase 9 API smoke (supertest) | `NODE_ENV=test node --import ./tests/global-test-db-serial.js scripts/digital-metals-phase9-api-smoke.js` | 2026-10-20 | **4 / 4 pass** (after second outbox dispatch pass for documents) |
| Production hardening bundle | `npm run test:hardening` | 2026-10-20 | **175 / 176 pass** on first run (1 flaky Redis limiter test); **175 / 175** on immediate re-run |
| Phase E/F closure | `npm run test:phase-ef-closure` | 2026-10-20 | **51 pass**, 1 skip (15k scan) |
| Phase 10 corrective bundle | `node scripts/run-phase-10-corrective-review.js` | 2026-10-20 | **11 / 11 suites pass** |
| V1 targeted (scheme/ecommerce/refund) | `node scripts/run-v1-targeted-gate.js` | 2026-10-20 | **219 pass**, 1 skip (~333s) |
| Full backend release | `npm run test:release` (`RUN_HEAVY=1`) | 2026-10-20 | **1732 / 1734 pass** on first run (~2.8h); **2 fail** — platform DM route acceptance drift (fixed below, re-verified) |
| Platform acceptance (post-fix) | `npm test -- tests/platform-route-validation.test.js tests/platform-mutation-valid-acceptance.test.js tests/platform-mutation-matrix.test.js` | 2026-10-20 | **Pass** (30 platform mutations, matrix + route coverage) |
| Portal typecheck | `npm run typecheck` (Tenant Admin) | 2026-10-20 | **Pass** |
| Portal unit tests | `npm test` (Tenant Admin) | 2026-10-20 | **156 / 156 pass** |
| Portal production build | `npm run build` (Tenant Admin) | 2026-10-20 | **Pass** |

### Defects fixed during Phase 11 (in scope)

| Issue | Fix | Files |
|-------|-----|--------|
| Platform validators added without acceptance tests | Added valid HTTP acceptance for pause, tax approve, terms publish; route count **27 → 30** | `tests/platform-mutation-valid-acceptance.test.js`, `tests/platform-route-validation.test.js` |
| Phase 9 API smoke statement stuck PENDING | Run **two** outbox dispatch passes (matches `digital-metals-phase9-documents.test.js`) | `scripts/digital-metals-phase9-api-smoke.js` |

**Note:** Full `npm run test:release` was not re-executed end-to-end after the two platform test fixes (runtime ~2.8h). Only the previously failing platform suites were re-run to **pass**.

## 2. Recovery & concurrency (evidence map)

| Requirement | Evidence | Infra |
|-------------|----------|--------|
| Buy webhook/poll/recovery credits once | `digital-metals-phase4.test.js`, `digital-metals-phase4-matrix.test.js` (concurrent webhook/poll) | In-memory Mongo |
| Late/additional captures → review/refund | `digital-metals-phase4-matrix.test.js`, payment harness tests in phase 4–5 | In-memory Mongo + payment test harness |
| Sell vs redemption holding competition | `digital-metals-phase5-matrix.test.js`, `digital-metals-phase6-matrix.test.js` | In-memory Mongo |
| Payout UNKNOWN blocks re-disbursement | `digital-metals-phase10-defects.test.js`, phase 6 payout tests | In-memory Mongo |
| Handover / physical-out once | `digital-metals-phase7.test.js`, `digital-metals-phase7-matrix.test.js` | In-memory Mongo |
| Outbox/document stale lease recovery | `digital-metals-phase4-matrix.test.js` (invoice lease), `digital-metals-phase9-documents.test.js` | In-memory Mongo |
| Notification enqueue failure retryable | `digital-metals-phase10-corrections.test.js` (simulated `Message.create` failure) | In-memory Mongo |
| Logical resend retries devices, no inbox dup | `message-logical-push-resend.test.js`, `phase10-defects.test.js` | In-memory Mongo + **mock FCM** |
| Replacement shipment distinct idempotent notices | `digital-metals-phase10-correction-replacement-notice.test.js` | In-memory Mongo |
| BullMQ stable job ids / dispatch | `phase-e-dispatch.test.js` | **Redis available** (`redis-cli PONG`) |
| FCM Redis limiter / SCRIPT FLUSH recovery | `phase-d-fcm-redis.test.js` (in `test:hardening`) | **Local Redis** — occasional flake on shared instance |
| Worker process restart + job retention | `digital-metals-phase11-bullmq-recovery.test.js` (worker close mid-artifact + replacement worker + queue dispatch) | **Redis** — **3/3 pass** (2026-10-21) |
| Ecommerce promotion delayed jobs (Redis) | `ecommerce-promotion-not-due-redis.test.js`, fanout reliability tests (V1 gate) | Redis when run in full suite |

## 3. Browser & PDF verification

### Local stack (smoke)

| Component | Setting |
|-----------|---------|
| API | `http://localhost:4050` — **`PORT=4050` `PROVIDER_MODE=mock`** (required for statement download-url) |
| Worker | `PROVIDER_MODE=mock` (document artifact upload to `.mock-storage/`) |
| Portal | `http://localhost:5173`, `NEXT_PUBLIC_USE_MOCKS=false` |
| Seed | `node --env-file=.env scripts/digital-metals-phase9-browser-setup.js` |

### Playwright Phase 9 smoke

| Run | Command | Result |
|-----|---------|--------|
| 2026-10-20 (initial) | `FRONTEND_BASE=http://localhost:5173 API_BASE=http://localhost:4050/api/v1 npx playwright test scripts/digital-metals-phase9-browser-smoke.spec.js --workers=1` | **7 / 8 areas pass**; summary fail — `customer-statement-document` **download-url HTTP 500** (API not on mock presign) |
| 2026-10-20 (after API restart) | Same, after `lsof -ti :4050 \| xargs kill -9` and `PORT=4050 PROVIDER_MODE=mock npm run dev:api` | **8 / 8 pass** (~1.7m) |

**Artifacts:** `docs/phase9-browser-smoke-results-2026-10-20T14-03-01-678Z.json` → `docs/phase9-browser-smoke-results-latest.json`

**Areas covered:** portal↔API, procurement maker/approver, hedge deep link + invalidation banner, admin sell/payout/redemption surfaces, customer statement PDF + **download-url**, paused trading capability, permission denial (Kochi staff).

### PDF visual QA (prior + automated bytes)

| Check | Evidence |
|-------|----------|
| Multipage statement / receipts | `docs/phase9-pdf-samples/` (6 PDFs + PNG); generated via `scripts/digital-metals-phase9-pdf-samples.js` (Phase 9) |
| API PDF byte + presign refresh | `tests/digital-metals-phase9-documents.test.js` |

## 4. Deployment preparation (do not run on production from this pass)

### Indexes & duplicate preflight

```bash
# Inbox duplicate scan (no writes)
node --env-file=.env scripts/detect-message-inbox-event-key-duplicates.js --dry-run

# Review planned index changes (no apply)
npm run db:sync-indexes:dry-run

# Apply only after review on target environment
npm run db:sync-indexes
```

Partial unique indexes for Message `reminderDedupeKey` / `templateParams.inboxEventKey` — see `docs/DIGITAL_METALS_API_CONTRACT.md`.

### Rollout order (typical)

1. Deploy API with Digital Metals routes + validators (contract lock **456** routes).
2. Run index sync + duplicate preflight on target DB.
3. Deploy **worker** + **scheduler** (outbox dispatch, document artifacts, notification processor, intent repair cursors).
4. Restart workers after env changes (`PROVIDER_MODE`, storage, FCM, Redis URL).
5. Enable feature per tenant (below).

### Feature flags & pilot prerequisites

| Prerequisite | Owner |
|--------------|--------|
| Subscription plan feature `digitalMetals` | Platform subscription |
| Tenant `operations.digitalMetalsEnabled` | Platform / tenant ops |
| Platform tax profile approve + terms publish | Platform console |
| Admin asset settings + published rates | Tenant admin |
| Opening hedge / procurement (if hedging) | Tenant admin |
| Payment gateway + test harness off in prod | Tenant integrations |

### Monitoring & recovery

| Signal | Action |
|--------|--------|
| `GET /admin/digital-metals/operations/work-queue` | Stuck outbox/documents |
| Outbox `processedDisposition` SKIPPED vs COMPLETED | Ops metrics — no false “delivered” on SKIPPED |
| `POST …/operations/outbox/:eventId/retry` | Safe notification retry |
| Platform pause | `POST /platform/tenants/:tenantId/digital-metals/pause` — preserves holdings/settlement access per spec |
| Rollback | **Limited** — business transitions are forward-only; pause + ops retries; no automatic metal reversal on deploy rollback |

### Staging-only (BLOCKED locally)

| Check | Status |
|-------|--------|
| Live PhonePe buy/redemption charges | **BLOCKED** — use `ECOMMERCE_PAYMENTS_TEST_HARNESS` locally only |
| Real S3 (or prod object storage) presign + PDF bytes | **BLOCKED** — local smoke uses `PROVIDER_MODE=mock` |
| Physical-device FCM delivery | **BLOCKED** — mock FCM / test hooks only |
| Staff-attested live bank payout on real account | **BLOCKED** — maker/approver flows tested in Mongo harness |

## 5. Product rules (verified by suite design — not re-litigated here)

- No physical-stock gate on digital purchases.
- Customer metal wallets; no reloadable INR wallet.
- Reservations protect holdings; manual payouts retain maker/approver + attestation labels.
- Pauses/downgrades preserve holdings, settlement, fulfilment, recovery (`digital-metals-phase9-boundaries.test.js`, capability tests, browser pause area).

---

## Final verdict (2026-10-21 final verification pass)

| Scope | Result |
|-------|--------|
| **22 recorded release failures** | **Fixed in source** — shared Mongo lifecycle + `--test-isolation=none` + boot mutex; **25/25** targeted re-run pass (`/tmp/swarna-verify-22-rootcause-v3.log`) |
| **Full backend `npm run test:release`** | **IN PROGRESS** — `/tmp/swarna-test-release-2026-10-21T154500Z.log` (prior `/tmp/swarna-test-release-1792580111.log`: **1738 pass / 22 fail**) |
| **Portal check / test / build** | **PASS** — typecheck + **171/171** vitest + production build (2026-10-21T15:45Z) |
| **Expanded browser flows A–D + responsive screenshots** | **BLOCKED** — not run this pass |
| **Staging / production** | **BLOCKED** — PhonePe live, real object storage, physical FCM, operational bank/delivery |

**Staging-only (not local PASS):** live PhonePe capture/payout, production S3/GCS presign, real FCM device delivery, courier/bank settlement probes, physical handover on shop floor.

**Remediation evidence (dirty tree @ `3df60d8246bc8860e66bcb947f14f907aa070f83`):**

| Command | Result |
|---------|--------|
| `npm run check` | **Pass** (847 JS files, 456 routes, ESLint) |
| Digital Metals suite (`digital-metals-*.test.js`, resend, route-coverage-dm, export manifest) | **175 / 175 pass** (~8m) |
| `tests/message-logical-push-resend.test.js` | **12 / 12 pass** (transaction rollback, expired claim, new device, concurrent resend) |
| `tests/digital-metals-phase11-shipment-replay.test.js` | **3 / 3 pass** (incl. post-commit HTTP crash replay) |
| `tests/digital-metals-phase11-bullmq-recovery.test.js` | **3 / 3 pass** (stale lease + BullMQ worker loss + Redis smoke) |
| `tests/digital-metals-phase11-catalogue.test.js` | **3 / 3 pass** |
| `tests/export-source-manifest.test.js` | **7 / 7 pass** (incl. `tests/fixtures/app-config.json` regression) |
| `tests/digital-metals-production-harness.test.js` | **2 / 2 pass** |
| Tenant Admin `npm test` | **159 / 159 pass** |
| Tenant Admin `npm run typecheck` + `npm run build` | **Pass** |

**Source exports (verified manifest):**

| Archive | SHA-256 |
|---------|---------|
| `/Users/aadithgino/Developer/Swarna Grow/swarnagrow-backend-source-2026-10-21T153849Z.zip` | `078648efd6ab9e0a6c9c624aa45f1f35e83ef9cae39615f465f335889777ee95` |
| `/Users/aadithgino/Developer/Swarna Grow/swarnagrow-tenant-admin-source-2026-10-21T153849Z.zip` | `ab59105597c993e597af0d76ec5d3f4515954ae4c6425aa31d55772b93fc59b5` |

*(Re-export after boot mutex: pending — mutex landed after this ZIP; included in dirty tree.)*

Extract-spot-check: `scripts/verify-source-export-manifest.mjs`, `tests/digital-metals-phase11-catalogue.test.js`, `src/lib/digital-metals-settings-form.test.ts` present in archives.

### Requirement → code / test matrix (Phase 11)

| Requirement | Backend | Portal | Tests |
|-------------|---------|--------|-------|
| Metal wallets / reservations | `digital-metals-ledger.service.js` | customer buy/sell/redeem pages | phase4–7 matrix, phase6 holding competition |
| Buy (gold/silver) | buy finalize/payment services | `customer-digital-metals-buy-pages.tsx` | phase4/5, production harness off in prod |
| Sell + payout maker/approver | sell/payout services | sell pages, payout detail | phase5/6/10 |
| Per-asset settings | settings service | `digital-metals-config-editor.tsx` | `digital-metals-settings-form.test.ts` |
| Redemption catalogue edit | `digital-metals-redemption.service.js` | `digital-metals-redemption-pages.tsx` | `digital-metals-phase11-catalogue.test.js` |
| Redemption charges / zero path | charge payment/reconcile | customer redeem flow | phase6/7 |
| Pickup / delivery / handover | fulfilment service | redemption admin + customer | phase7, phase11 shipment replay |
| Documents / statements | document-artifact, PDF libs | document panels | phase9 documents |
| Notifications / deep links | outbox, inbox, push | customer shell routes | phase10 corrections, resend suite |
| Hedge reporting | hedge service | hedge page | phase8/ops |
| Push logical resend | `push-delivery.service.js`, `message-logical-resend.js` | — | `message-logical-push-resend.test.js` (12) |
| Export fail-closed | `verify-source-export-manifest.mjs` | package script | `export-source-manifest.test.js` |
| Worker recovery | outbox dispatch, BullMQ | — | `digital-metals-phase11-bullmq-recovery.test.js` |

| `npm run test:release` | **IN PROGRESS** — `/tmp/swarna-test-release-2026-10-21T154500Z.log` (expect ~1760 tests, ~79–155m). Prior fail log: `/tmp/swarna-test-release-1792580111.log` (**22 fail**, infra). |

**Phase 11 final verification (2026-10-21T15:45Z):** Harness fixes + portal **171/171** vitest + build pass. **`npm run test:release` running** (single runner; no `tail` masking). **Browser flows A–D** and **390/768/1440 screenshots** not completed. Staging **BLOCKED**. No commit, push, deploy, or live transactions.
