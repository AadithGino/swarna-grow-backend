# P8 release evidence (2026-11-01)

**Paired ZIP export:** **blocked** — final `test:release` on source below ended with **`ℹ fail 7`** (not gate-green).

## `resolveDatePreset` / IST calendar fix

**Change:** `src/lib/query-filters.js` — `resolveDatePreset()` uses `istNow()` from `src/lib/date.js` so test calendar override (`setCalendarDateOverrideForTests`) and production IST policy stay aligned (fixes assistant `LAST_MONTH` vs wall-clock drift).

**Focused verification (agent-run):**

```bash
cd swarnagrow-backend
LOG_LEVEL=error NODE_ENV=test node --import ./tests/global-test-db-serial.js \
  --test --test-concurrency=1 --test-force-exit \
  --test-name-pattern="period LAST_MONTH|last-month grouped" \
  tests/assistant-query-compiler.test.js
```

| Test | Result |
|------|--------|
| `period LAST_MONTH adds paidAt Date range on collections` | **Pass** |
| `last-month grouped collections return tenant-scoped rows with labels` | **Pass** |

**Incomplete / aborted release attempts (do not count as gate):** earlier `test:release` runs stopped mid-suite (shell aborted); first completed attempt on post-fix source had 2 assistant failures before `query-filters` fix.

---

## Final-source `npm run test:release` (post `query-filters` fix)

| Field | Value |
|-------|--------|
| **Backend git SHA** | `30b3e479bc8731247bdcad30efd363920cb1e8d5` (uncommitted working tree may differ — verify `git rev-parse HEAD` before re-run) |
| **Tenant Admin git SHA** (frontend gates) | `4c55de048a3d2f39ad58ed7dd7c9de7597c7c18e` |
| **Command** | `npm run test:release` → `RUN_HEAVY=1 NODE_ENV=test node --import ./tests/global-test-db-serial.js --test --test-concurrency=1 --test-force-exit --test-reporter=spec` |
| **Log file** | `/tmp/swarna-test-release-2026-11-01.log` |
| **Started** | 2026-11-01 (restart after `query-filters` fix; prior log deleted) |
| **Duration** | `ℹ duration_ms 4291125.4855` (~71.5 min) |
| **Process exit** | **Non-zero** (Node test runner reports failures; do **not** treat piped shell `exit 0` as pass) |
| **ℹ tests** | **2000** |
| **ℹ pass** | **1993** |
| **ℹ fail** | **7** |
| **ℹ cancelled** | **0** |
| **ℹ skipped** | **0** |
| **ℹ suites** | **21** |
| **RUN_HEAVY** | **Confirmed** — log line 3 `RUN_HEAVY=1`; heavy case **pass**: `15000-scheme reminder scan uses bounded batches without monotonic heap growth` (~325s). Additional scheduler-heavy tests passed in same run. |

### Seven failures (must be zero before export)

| # | Test | Symptom |
|---|------|---------|
| 1 | `digital-metals-phase5.test.js` — sell execution / payout maker | Expected **403**, got **200** on self-approve payout |
| 2 | `digital-metals-phase7.test.js` — pickup handover | `rate publish failed: 500` in `makeTenantQuoteReady` |
| 3 | `digital-metals-phase8-corrections.test.js` — IST Oct 18 handover | `physicalHandoverUg` **0** vs **1000000** |
| 4 | `digital-metals-phase8-corrections.test.js` — gap days credited buy | closing **0** vs **1000000** |
| 5 | `digital-metals-phase9-boundaries.test.js` — revision invalidates downstream | expected **true**, got **undefined** |
| 6 | `ecommerce-courier-cod.test.js` — duplicate batch line | Expected **409**, got **422** |
| 7 | `route-coverage-digital-metals.test.js` — missing DM route in lock | Checker surfaced **unguarded** `GET /admin/payments/needing-attention` instead of undeclared DM route |

---

## 18-item gate checklist

| # | Gate | Result |
|---|------|--------|
| 1 | P7 compatibility | **Pass** — `docs/P7_CUSTOMER_MOBILE.md` |
| 2 | Backend syntax | **Pass** — `npm run check` |
| 3 | Route / contract coverage | **Fail in release** — unguarded payments queue route (row 7 above); `npm run check` also warns same route |
| 4 | Outbox session audit | **Pass** |
| 5 | Backend ESLint | **Pass** |
| 6 | Full `test:release` | **Fail** — 7 failures (table above) |
| 7 | Heavy (`RUN_HEAVY=1`) | **Executed** (env in log); not gate-green until row 6 is **fail 0** |
| 8 | Tenant Vitest | **Pass** — 207/207 |
| 9 | Tenant lint | **Pass** |
| 10 | Tenant typecheck | **Pass** |
| 11 | Tenant production build | **Pass** |
| 12 | Admin journey smokes | **Pass** |
| 13 | Backend `npm audit --audit-level=high` | **Pass** |
| 14 | Tenant `npm audit --audit-level=high` | **Pass** |
| 15 | Migration dry-run | **Pass** |
| 16 | Worker shutdown | **Pass** (static) |
| 17 | Contract lock | **Pass** except payments route guard gap |
| 18 | `package:export` + verify (both repos) | **Not run** — blocked on row 6 |

---

## Next steps (gate-green)

1. Fix the seven failures (start with `GET /admin/payments/needing-attention` → `guarded` / `requirePermission` visible to `check-route-coverage.js`).
2. Re-run **`npm run test:release`** unpiped; require **`ℹ fail 0`**, **`ℹ cancelled 0`**, process exit **0**.
3. Then:

```bash
cd swarnagrow-backend && npm run package:export && npm run package:verify
cd SwarnaGrow-Tenant-Admin && npm run package:export && npm run package:verify
```

Append export manifest paths and verify hashes to this file.
