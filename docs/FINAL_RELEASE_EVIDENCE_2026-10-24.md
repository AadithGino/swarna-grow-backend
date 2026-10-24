# Final release evidence — 2026-10-24

**Tree:** working copy (uncommitted). **No deploy, live transactions, or broadcasts** in this pass.

## Automated gates (this run)

| Gate | Class | Evidence |
|------|--------|----------|
| Backend `npm run check` (syntax, 471 route coverage, ESLint) | **PASS** | Exit 0 — 2026-10-24 session |
| Assistant + security + export suites (11 files, 88 tests) | **PASS** | Exit 0 — `tests/assistant-*.test.js`, `auth-security`, `security-*`, `export-*`, `exports.test.js` |
| Digital Metals full batch (`tests/digital-metals-*.test.js`, 31 files) | **PASS** | **184 / 184** pass, exit 0 (~83s) after harness isolation fix |
| Ecommerce pricing / phase commerce / order / cancellation / return / mock-payment batch | **PASS** | **737+ tests**, 0 fail, exit 0 on confirm rerun (first combined run had 1× `ECONNRESET` flake on phase-E webhook — **not** retried as sole pass) |
| Frontend typecheck | **PASS** | `SwarnaGrow-Tenant-Admin` — exit 0 |
| Frontend Vitest (full) | **PASS** | 64 files, **181 / 181** tests |
| Frontend production build | **PASS** | `vinext build` complete |
| `npm run test:release` (`RUN_HEAVY=1`, unpiped) | **IN PROGRESS** | Log: `/tmp/swarna-test-release-2026-10-24.log` — started 2026-10-24; append `RELEASE_EXIT:` at completion |

## Test harness / isolation (migration note)

Under `--test-isolation=none`, **file-level `test.beforeEach` hooks from every loaded module run before each test**, not only the current file. That leaked `ECOMMERCE_PAYMENTS_TEST_HARNESS=true` into quote/COD tests and cleared harness for Digital Metals buy completion when `resetTestDb()` deleted the env var.

**Fixes (2026-10-24):**

1. **`resetTestDb()`** no longer deletes `ECOMMERCE_PAYMENTS_TEST_HARNESS`; explicit `disable` / `enable` helpers own the flag.
2. **Global `afterEach`** (in `tests/global-test-db-serial.js`) calls `disableEcommercePaymentsTestHarness()` so inline enables (e.g. phase-D1b `quoteAndOrder`) do not leak.
3. **Scoped suites:** payment-harness HTTP tests wrapped in `test.describe(...)` with harness `beforeEach` inside (phase E, test-harness, payment-audit, phase D1/D2/D2-hardening, integration-gaps, cancellation audit/evidence).
4. **`ecommerce-quote-phase-c.test.js`** disables harness in `beforeEach`.

No production API or route contract changes from this harness work.

## Sidekick / AI (automated)

| Item | Class | Evidence |
|------|--------|----------|
| Phase 9 follow-up reproduction (smoke customer focus, pronoun binding, payment follow-up) | **PASS** | `tests/assistant-memory.test.js` in assistant batch (88 tests green) |
| Ranking / date queries (“who paid most last month”) | **PASS** | `tests/assistant-refine-query.test.js` + memory suite |
| History reload / conversation switching | **PASS** | `tests/assistant-history.test.js`, `assistant-conversation-storage.test.ts` (portal) |
| Scoped exports, timeouts, retry | **PASS** | `tests/assistant-export.test.js`, LLM timeout in `src/integrations/llm/gemini.js` / `provider.js` |

## Digital Metals (automated HTTP / service)

| Flow | Class | Evidence |
|------|--------|----------|
| Mock buy → wallet / passbook | **PASS** | `digital-metals-phase4*.test.js`, idempotency, financial-gaps |
| Sell → reservation → approval → payable → payout | **PASS** | phase5–7 matrix, review-fixes, admin pagination |
| Zero-charge / paid redemption, pickup, delivery | **PASS** | phase6–7 matrix + delivery address fixture |
| Cancellation, expiry, late success, refunds | **PASS** | phase8–10, shipment replay |
| Pause / downgrade with obligations | **PASS** | phase4-matrix, demo-policy tests |
| Cross-customer / branch / tenant denial | **PASS** | phase9-boundaries, auth tests |

## Ecommerce (automated)

| Flow | Class | Evidence |
|------|--------|----------|
| Visibility, pricing breakup | **PASS** | `ecommerce-pricing.test.js`, quote capability |
| Address → quote → order → mock pay | **PASS** | phase C–E, test-harness HTTP (scoped) |
| Admin fulfilment, cancellation, return, stock once | **PASS** | order-cancellation-*, return-inspection-restock |
| Promotions / schedules | **PASS** | `ecommerce-promotion-regression.test.js`, `ecommerce-product-schedule-persistence.test.js` |

## Live stack + browser

| Item | Class | Requirement |
|------|--------|-------------|
| API `:4000` health | **BLOCKED** | `curl` returned **404** (no standard health on bound port) |
| Portal `:5173` | **BLOCKED** | Connection failed — stack not running in verification environment |
| DM / ecommerce / AI manual flows | **BLOCKED** | Requires API + Redis + worker + scheduler + portal |
| Responsive 390 / 768 / 1440 | **BLOCKED** | Requires portal + browser |

## API contracts / route lock

| Item | Class | Notes |
|------|--------|-------|
| Route coverage lock (`npm run check`) | **PASS** | 471 applicable contract routes |
| Admin DM list pagination (`meta.cursor`, payables `id`) | **PASS** | `digital-metals-admin-list-pagination.test.js`; portal types in `admin-api.ts` |
| Redemption charge refunds admin list | **PASS** | Route + mock server meta (prior handoff) |

## Release verdict (automated slice)

**PASS** for all completed automated gates listed above. **BLOCKED** for live/manual/browser until local stack is up. **`test:release` must finish green** on `/tmp/swarna-test-release-2026-10-24.log` before treating the full backend as release-closed.
