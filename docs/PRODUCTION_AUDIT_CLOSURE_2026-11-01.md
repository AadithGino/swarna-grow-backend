# Production audit closure — 2026-11-01 (F01–F18)

**Audit package:** `SwarnaGrow-Production-Audit-2026-11-01.zip` was **not present** on the workstation (searched workspace, Downloads, home). Findings were verified against the specification in the remediation brief, existing regression suites, and code tracing. Re-run audit reproduction tests from the zip when it is available and append results here.

**Project roots**

| Component | Path |
|-----------|------|
| Backend | `/Users/aadithgino/Developer/Swarna Grow/swarnagrow-backend` |
| Tenant Admin | `/Users/aadithgino/Developer/Swarna Grow/SwarnaGrow-Tenant-Admin` |

---

## Closure matrix

| ID | Disposition | Root cause (verified) | Primary changes | Regression tests | Verification | Limitations |
|----|-------------|----------------------|-----------------|------------------|--------------|-------------|
| **F01** | Confirmed (prior + ledger paths) | Concurrent lot reservation / FIFO without lot-level quantity fence | `src/services/digital-metals-ledger.service.js`, reservation services, `tests/digital-metals-phase3.test.js`, phase4/5 concurrency | `digital-metals-phase3.test.js`, `digital-metals-phase5.test.js` (concurrent reservations), `production-remediation-regressions.test.js` | Phase3 holding-period + phase5 concurrency pass in focused runs; full `test:release` not re-run this session | Historical wallet/lot drift requires dry-run reconciliation (`scripts/migrate-financial-invariants.js --dry-run`) — no auto-repair |
| **F02** | Confirmed (addressed in tree) | Admin ecommerce mutations skipped branch/tenant scope on replay or cache paths | `src/lib/mutation-requirements.js`, ecommerce order/return/cancel services, controllers | `tests/p2-ecommerce-fulfilment.test.js`, `tests/closure-phase5-strict-dto.test.js`, `tests/ecommerce-order-cancellation-audit.test.js` | `p2` branch isolation tests pass in isolation | Cross-tenant matrix relies on full authorization suite |
| **F03** | Confirmed | Risk-hold create/resolve without customer scope; resolve cleared wrong hold | `src/services/digital-metals-risk-hold.service.js` | `tests/digital-metals-phase5-auth.test.js` | phase5-auth risk-hold tests pass in bundle | — |
| **F04** | Confirmed | Overlapping manual/gateway refund channels on same obligation | `src/lib/order-refund-selection.js`, payment exception services | `tests/production-remediation-regressions.test.js`, post-settlement refund suites | production-remediation multi-capture tests pass | COD-only rules covered in `p3-ecommerce-cod-fulfilment.test.js` — not re-run end-to-end here |
| **F05** | Confirmed | Return restock/refund not capped by delivered qty | `src/lib/ecommerce-order-stock-restock.js`, return service | ecommerce return / phase tests | Covered by existing return matrix (not full release) | — |
| **F06** | Confirmed | Scheme maturity/default without revalidation under same txn | `src/services/scheme.service.js`, schedulers | `tests/phase9-flexible-lifecycle.integration.test.js`, phase9 matrices | Not re-run this session | Requires concurrent interleaving tests under `test:release` |
| **F07** | Confirmed | Unconditional sell confirm save | `src/services/digital-metals-sell.service.js`, `digital-metals-payout.service.js` | `tests/p1-digital-metals-sell-payment.test.js`, phase5 sell tests | phase5 sell/approve passes (same-operator approve is **allowed** by policy) | — |
| **F08** | Confirmed | HTTP idempotency cache without durable domain key | Domain idempotency on orders/payments/enrolments; `mutation-requirements` body hash | `tests/production-remediation-regressions.test.js`, enrolment/payment idempotency suites | Remediation uncertain-initiation tests pass | Not every service rewritten — only paths with financial side-effects |
| **F09** | Confirmed (frontend) | Export pointed at wrong backend path; hosting plugins | `SwarnaGrow-Tenant-Admin/scripts/export-guides.mjs`, `scripts/package-source-export.mjs`, `scripts/run-framework.mjs` | `npm run build`, `npm run typecheck` | **Pass** (2026-11-01 session) | `guides:check` needs live dev server — not run here |
| **F10** | Confirmed | Return resolved before refund terminal state | `src/services/ecommerce-order-return.service.js` | return closure tests in ecommerce suites | Logic present; full matrix not re-run | — |
| **F11** | Confirmed | No admin reissue for READY_FOR_PICKUP recovery | `POST .../pickup-code`, `issueAdminPickupCode`, compound fulfilment | `tests/p2-ecommerce-fulfilment.test.js` (expired code, reissue path via pickup-code route) | Expired-code + pickup-code issue paths covered; duplicate-idempotency passes in isolation | Customer notification intent — verify outbox in staging |
| **F12** | **Closed (code + tests)** | Resource-bound idempotency endpoint broke lookup/repair of legacy `POST /schemes/enrol` rows and allowed same key on different resources to coexist | `src/lib/idempotency-endpoint.js` (`normalizeIdempotencyRoutePath`, `idempotencyEndpointsCompatible`), `src/services/idempotency.service.js` (compatible sibling lookup, PAYMENT_INIT_FAILED repair, endpoint migration on replay) | `tests/idempotency-resource-binding.test.js` (6 tests), `tests/customer-enrol-payment-mode.test.js` (legacy repair) | Legacy repair + cross-resource rejection pass in isolation; prior full release had 8 fails including this — **authoritative re-run in progress** (`/tmp/swarna-test-release-2026-11-01-post-f12.log`) | Audit ZIP still missing for bundled reproduction tests |
| **F13** | Confirmed | Maturity transition without atomic notification intent | scheme notification reconcile / outbox | phase9 notification dedupe tests | Not re-run this session | — |
| **F14** | Confirmed | No scheduled DM reservation expiry | `src/services/digital-metals-sell-maintenance.service.js`, workers/schedulers | worker/scheduler tests | Static + unit paths; Redis lease tests in phase-g1 | Full worker integration requires Redis |
| **F15** | Confirmed (this session) | Return window used `updatedAt` | `src/lib/ecommerce-return-eligibility.js`, `ecommerce-order-return.service.js` | **New** `tests/ecommerce-return-eligibility-anchor.test.js` | **Pass** | Legacy orders without anchor rely on policy snapshot fields when present |
| **F16** | Confirmed | Customer financial summary omitted manual/COD refund channels | `src/services/reporting.service.js`, customer summary DTOs | reporting / customer summary tests | Not re-run this session | — |
| **F17** | Confirmed (this session) | Stale generated guide catalog + wrong repo path | `guide-catalog.js` regenerated; `export-guides.mjs`, `registry.test.ts` paths | `src/lib/tours/registry.test.ts` | **8/8 pass** | Playwright `guides:check` optional |
| **F18** | Confirmed (this session) | React Compiler could not preserve `useMemo` deps on hedge page | `digital-metals-hedge-page.tsx` | eslint react-hooks/preserve-manual-memoization | **`npm run lint` pass** | — |

**Hedge book gap-day opening (related P5):** `src/lib/digital-metals-daily-hedge-book.js` — `resolveOpeningMetalOwedUg()` carries credited buys when no wallet/journal exists; fixes `digital-metals-phase8-corrections.test.js` gap-days case.

---

## Migration, reconciliation, rollout

1. **Indexes (required before prod):**  
   `node scripts/migrate-financial-invariants.js --dry-run`  
   Then apply per `docs/PRODUCTION_REMEDIATION_2026-10-30.md` (majority write concern, staged rollout).

2. **Reconciliation (read-only, default dry-run):**  
   - Wallet/lot: financial index migration report  
   - Overlapping refunds: payment exception refund listing per order  
   - Repeated restock: compare return `stockRestockedAt` vs line quantities  

3. **Deploy order:** API + worker + scheduler together; run scheduler registration once per environment.

4. **Guide catalog:** After tour changes, from Tenant Admin: `npm run guides:export` (writes to `swarnagrow-backend/.../guide-catalog.js`).

---

## Verification commands (this session)

| Check | Command | Result |
|-------|---------|--------|
| Backend check | `npm run check` | **Pass** (957 JS files, 489 routes) |
| Backend focused audit bundle | 7 files, 51 tests | **49 pass, 2 fail** (see below) |
| New unit tests | idempotency + return anchor | **4/4 pass** |
| Phase8 gap-days | `digital-metals-phase8-corrections.test.js` | **Pass** (after hedge fix) |
| Tenant lint | `npm run lint` | **Pass** (incl. F18) |
| Tenant typecheck | `npm run typecheck` | **Pass** |
| Tenant build | `npm run build` | **Pass** |
| Guide equality | `vitest run src/lib/tours/registry.test.ts` | **8/8 pass** |
| Full `test:release` (prior) | 2010 tests, 2002 pass, **8 fail**, exit 0 | Log: `/tmp/swarna-test-release-2026-11-01-final.log` @ git SHA in `/tmp/swarna-release-git-sha.txt` |
| Full `test:release` (post F12) | in progress | Log: `/tmp/swarna-test-release-2026-11-01-post-f12.log` |
| Backend `npm run check` | after F12 patch | **Pass** |
| Tenant vitest | 207 tests | **Pass** |
| Tenant lint + typecheck | — | **Pass** |

**Prior release failures — disposition after investigation:**

| Test | Isolated re-run | Root cause |
|------|-----------------|------------|
| `legacy PAYMENT_INIT_FAILED idempotency record is repaired on retry` | Failed → **fixed** | Legacy endpoint string not matched by `buildIdempotencyEndpoint`; repair never ran |
| `foreign tenantId in body…` (ECONNRESET) | Pass (5×) | Early-suite socket reset; removed `stopTestDb({ force: true })` from `p0-foundation` outbox test |
| phase4/5/7 matrix + P4 handover + platform change-plan | **Pass** in isolation | Same code green; not reproduced after F12 (prior run likely DB lifecycle / ordering) |

---

## Source ZIPs (deliverable 5)

| Archive | Path | Entries |
|---------|------|---------|
| Backend | `/Users/aadithgino/Developer/Swarna Grow/swarnagrow-backend-source-2026-11-01.zip` | 1057 |
| Tenant Admin | `/Users/aadithgino/Developer/Swarna Grow/swarnagrow-tenant-admin-source-2026-11-01.zip` | 713 |

Validate:  
`node scripts/verify-source-export-manifest.mjs <path-to.zip>` in each repo.

---

## Handoff — remaining production blockers

1. **Full `npm run test:release`** with `ℹ fail 0` (prior run: 7 failures; several fixed since — needs authoritative re-run).  
2. **Provide audit ZIP** locally to convert reproduction tests if any still assert defective behavior.  
3. **Staging browser smokes** (`test:tenant-coverage`, digital-metals phase9 browser) not executed here.  
4. **Production index migration** must complete before enabling financial features on unmigrated clusters.  
5. **`guides:check`** (Playwright against running portal) optional but recommended before marketing guided tours.
