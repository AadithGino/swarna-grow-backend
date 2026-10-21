# Digital Gold & Silver — implementation progress

**Phase 9 checklist:** `docs/DIGITAL_METALS_PHASE9_CHECKLIST.md`

## Phase checklist

| Phase | Status | Evidence |
|-------|--------|----------|
| 0–8 | **Done (corrected)** | Prior phases + phase8 correction tests |
| 9 | **Done (2026-10-19)** | Checklist + verification below |
| 10 | **Done — corrected (2026-10-20)** | Defect remediation + three correction passes (push resend delivery retry, replacement shipment notice, check gate); see summaries below |
| 11 | **Remediation + UX (2026-10-21)** | Reliability defects closed; admin/customer DM UX overhauled; **release harness fixed + `test:release` re-run in progress** — see below |
| 12+ | **Not defined** | — |

## Phase 9 verification summary (2026-10-19)

| Layer | Result |
|-------|--------|
| `NODE_ENV=test` digital-metals npm suite | **123 / 123 pass** (~306s), production-harness included |
| API smoke script (memory Mongo) | **4 / 4 pass** |
| Backend `npm run check` | **Pass** (452 contract routes) |
| PDF pipeline visual QA | **Pass** (6 PDFs + PNG under `docs/phase9-pdf-samples/`) |
| Browser smoke (Playwright) | **8 / 8 pass** — post–Phase 10 correction re-run: `docs/phase9-browser-smoke-results-2026-10-19T06-53-10-759Z.json` → `docs/phase9-browser-smoke-results-latest.json` (API `:4050`, portal `:5173`, ~1.2m) |

### Local smoke prerequisites

- API + worker: **`PORT=4050` `PROVIDER_MODE=mock`** (backend cwd)
- Portal: `http://localhost:5173`, `NEXT_PUBLIC_USE_MOCKS=false`
- Seed: `node --env-file=.env scripts/digital-metals-phase9-browser-setup.js`
- Run: `npm run test:digital-metals-phase9-browser-smoke`

### Fixes during verification

- Statement stall: live S3 credentials on worker/API → use **mock storage** for local smoke
- Procurement list empty in UI: **`contractPayload(list.data)`** on procurement page (RTK contract envelope)
- Browser smoke: bounded artifact poll, ERR_ABORTED diagnostics, run-scoped result files

## Phase 10 verification summary (2026-10-20, corrected)

| Area | Result |
|------|--------|
| Transactional notifications | Digital-metal outbox → `deliverDigitalMetalCustomerPushNotice` → Message row with **unique** `reminderDedupeKey` + `templateParams.inboxEventKey` (real Mongo dedupe under concurrency). |
| Dispatch outcomes | **COMPLETED / SKIPPED / RETRYABLE / TERMINAL** via `classifyDigitalMetalOutboxDispatchOutcome`; **`QUEUE_FAILED` never marks PROCESSED**; attempts + `lastError` retained on retry. |
| Durable intent | Outbox **unique** `(tenantId, topic, key)`; document **READY + notice** in one transaction; payout failure/unknown + fulfilment accept in transactions; bounded **`reconcileMissingDigitalMetalNotificationIntents`** on dispatch; READY document retry re-issues missing notice. **Delivery dispatch / replacement dispatch** persist `shipmentEventId`, outbox intent, and order update in one transaction; replay via idempotency key on `shipmentHistory`. |
| Deep links | Match `customer-router.tsx`: `order/{id}`, `sell-order/{id}`, `redeem-order/{id}`, **`document/{artifactId}`** landing page. |
| Document smoke | API PDF byte + presign refresh tests; browser lib `verifyPdfDownloadUrl` (mock-local vs remote). |
| Operational UI | Work queue + safe retries (unchanged). |
| Tests | **Real Mongo (in-memory)** — `digital-metals*.test.js` + `message-logical-push-resend.test.js` + `route-coverage-digital-metals.test.js` → **154/154 pass** (~7m). Includes `phase10-correction-replacement-notice.test.js` (6), `message-logical-push-resend.test.js` (6, **mock FCM** via `pushProviderTestHooks`). Portal: typecheck **pass**; digital-metals vitest subset **pass** (no portal UI/API contract change this pass). |
| Backend `npm run check` | **Pass** (456 routes; ESLint includes `scripts/**/*.mjs`) |
| Browser smoke (prior) | **8 / 8 pass** — `docs/phase9-browser-smoke-results-2026-10-19T12-10-03-999Z.json` (not re-run this pass) |
| Not claimed | **Real Redis/BullMQ** job retention, **physical-device FCM** (manual gate). Push resend tests exercise **`processMessage`** with **mock FCM**, not live Firebase. |
| Blockers | None for Phase 10 corrected scope |

### Phase 10 corrections (same day)

- Atomic inbox claim replaces `Message.exists` + create race.
- Delayed/superseded transitions: `DELAYED_TRANSITION` retries; `SKIPPED_SUPERSEDED` completes without false delivery.
- Customer document deep-link route + RTK `getCustomerDigitalMetalsDocument`.

### Phase 10 defect remediation (2026-10-19)

| Defect | Fix | Evidence |
|--------|-----|----------|
| Missing-intent recovery starvation | Per-stream **repair cursors** (`DigitalMetalNotificationIntentRepairCursor`); marker backfill when outbox exists; buy/sell/redemption/document/payout streams | `phase10-defects.test.js` — 60-order cursor advance (real Mongo) |
| Message uniqueness vs resend | Pre-read dedupe + txn-safe duplicate handling; **`resendMessage`** logical PUSH retry via `message-logical-resend.js`; duplicate preview script | `phase10-defects.test.js` transactional `ALREADY_NOTIFIED` + resend; dev Mongo duplicate scan **0 groups** (`detect-message-inbox-event-key-duplicates.js --dry-run`) |
| Unknown payout resolution crash gap | `UNKNOWN → FAILED` payout state + **`enqueuePayoutCustomerNotice`** in one `withTransaction`; SETTLED path unchanged (settlement txn owns notice) | `phase10-defects.test.js` atomic outbox + idempotent re-resolve |
| Skipped outcome classification | SKIPPED before COMPLETED; **`processedDisposition` / `processedSkipReason`** on outbox; terminal vs retryable explicit | Exhaustive set tests + dispatcher persistence test (real Mongo) |

**Messaging regressions:** `phase-e-dispatch.test.js` + `phase-d-broadcast-recovery.test.js` **pass** (in-memory Mongo; no Redis job drain in these files).

### Phase 10 correction pass (2026-10-20)

| Issue | Fix | Evidence |
|--------|-----|----------|
| Logical PUSH resend stuck QUEUED | `prepareDeliveriesForLogicalResend` + bounded `logicalResendCount`; terminal outcomes when no retry targets | `message-logical-push-resend.test.js` (mock FCM + real Mongo); `phase10-defects.test.js` resend |
| Replacement shipment notice | `REPLACEMENT_DISPATCHED` + `shipmentEventId` outbox/inbox keys; dispatch idempotency | `phase10-correction-replacement-notice.test.js` |
| `npm run check` ESLint on `.mjs` scripts | `eslint.config.js` includes `scripts/**/*.mjs`; drop redundant `/* global console */` | `npm run check` |

## Phase 11 release verification (2026-10-20)

**Verdict: PASS (local automated + mock providers).** This is **not** production approval. Staging PhonePe, real storage, physical FCM, and live bank attestation remain **BLOCKED** — listed in the release checklist.

| Layer | Result |
|-------|--------|
| `npm run check` | **Pass** (456 routes) |
| Digital Metals suite + resend + route coverage | **154 / 154** |
| `npm run test:release` | **1732 / 1734** first run (~2.8h); **2 fail** platform DM acceptance drift → **fixed + re-verified** (30 routes); full re-run not repeated |
| Hardening + Phase E/F + V1 targeted + Phase 10 corrective | **Pass** (see checklist) |
| Portal typecheck + vitest + build | **Pass** (156 tests) |
| Phase 9 API smoke | **4 / 4** (document flow: double outbox dispatch) |
| Playwright browser smoke | **8 / 8** after `PROVIDER_MODE=mock` API on `:4050` — `docs/phase9-browser-smoke-results-latest.json` |
| Redis / BullMQ | Local **Redis PONG**; hardening includes `phase-d-fcm-redis` + `phase-e-dispatch`; **worker restart retention** not integration-proven → **BLOCKED** |

### Phase 11 fixes (in scope)

- Platform mutation valid acceptance for digital-metals pause / tax approve / terms publish (`tests/platform-mutation-valid-acceptance.test.js`, route count 30).
- Phase 9 API smoke: second outbox dispatch for statement READY (`scripts/digital-metals-phase9-api-smoke.js`).

**No commit, push, deploy, prod DB migration, or live financial/notification traffic in this pass.**

## Phase 11 remediation (2026-10-21)

**Verdict:** **PASS (local) — partial** until unpiped `npm run test:release` completes and expanded browser flows A–D run. Automated Part 1 + portal gates **green** on 2026-10-21 (this session). Staging manual gates **BLOCKED**.

| Finding | Implementation | Test / gate evidence |
|---------|----------------|----------------------|
| Concurrent first-time push delivery rows | `ensurePushDeliveries` → per-device `$setOnInsert` upsert (session-aware) | `phase-d-processor-concurrency.test.js` concurrent `processMessage`; resend suite **12/12** |
| Export credential scan too loose | Scan `tests/` content; skip markers only in `export-source-manifest.test.js` + PEM in `*.test.js`; deny `tests/fixtures/app-config.json` from ZIP | `export-source-manifest.test.js` **7/7**; `npm run package:export` manifest OK |
| Worker restart not proven | BullMQ worker1 stall → lease expiry → worker2 + queue dispatch | `digital-metals-phase11-bullmq-recovery.test.js` **3/3** (Redis) |
| Ecommerce cancellation flake (stock restock) | Version-conflict retry in `ecommerce-order-stock-restock.js` | `ecommerce-order-cancellation-audit.test.js` (focused batch **28/28** with export/resend/processor) |
| Admin DM navigation sprawl | `digital-metals-admin-nav.tsx` + layout on all DM routes | Portal typecheck + build pass |
| Raw JSON / paise / µg in admin UI | Rupee/gram display helpers; quote breakdown component; fulfilment reason required | `digital-metals-settings-form.test.ts` **3/3**; portal **159/159** vitest |
| Customer portfolio / buy asset default | Gram labels; silver-only asset selection after capability load | `customer-digital-metals-buy-pages.tsx` effect; existing customer DM vitest subset pass |
| Source ZIPs | `swarnagrow-*-source-2026-10-21.zip` | SHA-256 below; extract spot-check |

**Source exports (2026-10-21):**

| Archive | SHA-256 |
|---------|---------|
| `/Users/aadithgino/Developer/Swarna Grow/swarnagrow-backend-source-2026-10-21.zip` | `e76688998cb29bb999dca7f8a3a06a4d605faebc73b17a0112eaaba09e67c682` |
| `/Users/aadithgino/Developer/Swarna Grow/swarnagrow-tenant-admin-source-2026-10-21.zip` | `e68a42ffe3fd2e8a4bb284258da9e7cd15ec5f32bdf2e9e32dd5797d5f5b2cc4` |

**Source identity (2026-10-21 evening pass):** backend `3df60d8246bc8860e66bcb947f14f907aa070f83`, tenant-admin `a9d83e557ea05b4364a410483b6e3efdff81a42a`, branch `ecommerce`, **dirty** WIP (uncommitted).

**Still outstanding:** Full `npm run test:release`; Playwright expanded flows A–D; staging (PhonePe, FCM, storage, bank).

## Audit fixes (2026-10-21, focused pass)

| Finding | Fix | Evidence |
|---------|-----|----------|
| Quote preview wrong DTO fields | `digital-metals-quote-preview.tsx` uses `feePaise`/`taxPaise`/`totalPayablePaise`/`settlementPaise`/`rateSnapshot` | `digital-metals-quote-preview.test.tsx` **4/4** |
| Portfolio combined gram headline | Per metal+purity held/available/reserved; combined INR only if all valuations OK | `digital-metals-portfolio-summary.test.ts` **2/2** |
| Export test depended on excluded fixture | Synthetic credential JSON in temp dir only; fresh zip verifier test | `export-source-manifest.test.js` **8/8** + package export |
| Cancellation restock in-txn retry ineffective | WriteConflict + `withTransientTransactionRetry` on admin cancel decision | `ecommerce-order-cancellation-audit.test.js` **4/4** (PAID online pattern); export+cancel batch **12/12** |

**Validation (2026-10-21 audit pass):**

| Gate | Result |
|------|--------|
| Portal `npm run typecheck` | pass |
| Portal vitest quote + portfolio | **6/6** |
| Backend `export-source-manifest.test.js` + fresh extracted zip | **8/8** |
| Backend `npm run check` (syntax, route coverage, eslint) | pass (849 JS files, 456 routes) |
| Full `npm run test:release` | not run this pass |

## Customer portal UI (2026-10-21)

Customer-routed Digital Metals pages overhauled (portfolio, buy/sell/bank/redeem/document). See `SwarnaGrow-Tenant-Admin/docs/CUSTOMER_DIGITAL_METALS_UI.md`. Portal vitest **169/169**; **browser screenshots not captured**.

## Tenant admin UX (2026-10-21)

Overview uses API-backed queue counts (`digital-metals-workspace-overview.tsx`); purchases/sells lists have filter/search/pagination; payout/sell/redemption require explicit attestation checkboxes before financial actions. See `SwarnaGrow-Tenant-Admin/docs/DIGITAL_METALS_ADMIN_UI.md`. Playwright capture script added; **screens not captured** (staff auth + dev server).

## Local verification summary (2026-10-21T15:45Z — final pass)

### Recorded 22 `test:release` failures — root cause (log `/tmp/swarna-test-release-1792580111.log`)

| Group | Count | Evidence |
|-------|-------|----------|
| MongoMemoryReplSet boot / `ECONNREFUSED` during `auth-security` + `authorization` | **21** | Per-file Mongo teardown + default **process isolation** restarted in-memory Mongo hundreds of times; 10s launch timeout under contention |
| `ecommerce-commerce-phase-d2-hardening-http` quote step `400 !== 201` | **1** | Same infra window (not a product assertion change) |

### Harness fixes (this tree, dirty @ `3df60d8246bc8860e66bcb947f14f907aa070f83`)

| Fix | File |
|-----|------|
| `launchTimeout: 120_000`; per-file `stopTestDb()` clears Redis/rate-limit only; `stopTestDb({ force: true })` on process end | `tests/helpers/db.js` |
| Process-level `before`/`after` Mongo lifecycle | `tests/global-test-db-serial.js` |
| **`--test-isolation=none`** on `npm test` / `test:release` (single shared replset) | `package.json` |
| **`--test-force-exit`** on `npm test` only (avoids hang after small suites; **not** on `test:release`) | `package.json` |
| Boot mutex (`testDbBootPromise`) — no parallel `MongoMemoryReplSet.create` | `tests/helpers/db.js` |
| Portal hub open-orders mock | `customer-digital-metals-portfolio-ui.test.tsx` |

### Gates (2026-10-21T15:45Z)

| Gate | Result | Log |
|------|--------|-----|
| 22-failure bundle re-run | **25 / 25 pass** | `/tmp/swarna-verify-22-rootcause-v3.log` |
| Backend `npm run check` | **Pass** (863 JS, **465** routes) | `/tmp/swarna-verify-check-v2.log` |
| Portal typecheck + vitest + build | **Pass** (**171 / 171**) | `/tmp/swarna-portal-typecheck-v2.log`, `/tmp/swarna-portal-vitest-v2.log`, `/tmp/swarna-portal-build-v2.log` |
| Full `npm run test:release` | **IN PROGRESS** (0 fails early) | `/tmp/swarna-test-release-2026-10-21T154500Z.log` — **do not** use aborted `/tmp/swarna-test-release-2026-10-21T153837Z.log` (`--test-force-exit` + zombie mongod) |
| Phase 9 / expanded browser A–D + 390/768/1440 screenshots | **Not run this pass** | — |
| Staging PhonePe / prod storage / physical FCM | **BLOCKED (out of scope)** | — |

**Verdict: BLOCKED** until **`npm run test:release` completes green** and browser/visual gates run. Earlier **1757/1757** claim does **not** apply to this changed harness tree until the new log shows `EXIT:0`.

## Review fixes (2026-10-21, branch scope + PDF + demo policy)

| Area | Change |
|------|--------|
| Admin branch scope | `digital-metals-admin-scope.js` filters sell/redemption/fulfilment/buy/payout/payment-exception lists before limit; PDF + document artifact access uses `assertTenantOwnsCustomerScope` |
| Sell acknowledgement PDF | `settlementPaise` → labelled INR/grams via `digital-metals-document-pdf-fields.js` |
| Demo checkout / bank | Central `digital-metals-demo-policy.js`; persisted `checkoutMode` on payment attempts; bank list GET read-only; demo verify only via `DIGITAL_METALS_DEMO_BANK_VERIFY` on create or explicit helper |
| Portal gates | Redemption list query `limit`; sell detail optional DTO fields; wallet tab test mocks redemption query |

**Validation (focused):** `tests/digital-metals-review-fixes.test.js` **5/5** + production harness **2/2**; backend `npm run check` pass; portal typecheck + envelope test + build pass. Full `test:release` **not** re-run.

## Operational workflows (2026-10-21, bank verification + order tracking)

| Workflow | Backend | Tenant admin portal |
|----------|---------|---------------------|
| Manual bank verification | Queue + verify/disable APIs; masked DTOs; edit resets pending | Customer profile bank panel; `/digital-metals/bank-verification` queue |
| Customer order history | Paginated `buy-orders` / `sell-orders` / `redemption/orders` + `orders/open-summary` | Customer hub open-orders block; `/digital-metals/orders`; admin purchases/sells cursor pagination |

**Validation (focused):** `tests/digital-metals-bank-verification-and-orders.test.js`; backend `npm run check`; portal typecheck + vitest + build. No commit/deploy/live traffic.
