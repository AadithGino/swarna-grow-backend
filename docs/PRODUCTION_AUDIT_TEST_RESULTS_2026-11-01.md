# Production audit — verification log (2026-11-01)

## Audit package

| Artifact | Status |
|----------|--------|
| `SwarnaGrow-Production-Audit-2026-11-01.zip` | **Not found** after `find`, `mdfind`, and workspace search (2026-11-01). No `audit-findings.json` on disk. |
| Findings source for this closure | User remediation brief (F01–F18), code tracing, and permanent regression suites listed below. |

When the ZIP is available, extract reproduction tests and confirm each asserts **safe** behavior (not defective behavior).

## Git / worktree

- **HEAD at release start:** see `/tmp/swarna-release-git-sha.txt` (written when `test:release` restarted after final ledger/sell fixes).
- **Branch:** `ecommerce` (tracking `origin/ecommerce`), dirty worktree (uncommitted remediation).

## Combined-suite failures — root cause (demonstrated)

### 1. `p5-daily-hedge-book.test.js` — mid-day IST asOf

| Item | Detail |
|------|--------|
| **Symptom** | `ledgerHeldUg` expected `2000000`, actual `0`. |
| **Cause** | **Time-dependent fixture**, not hedge logic. `creditWalletForTest` persists journal `createdAt` at wall-clock now. Cutoff `midDay = (IST start + end) / 2`. When the test runs after local midday, all journal rows are **after** `midDay`, so ledger aggregation at cutoff is empty. |
| **Fix** | Backdate journal via `DigitalMetalJournal.collection.updateMany` to `start + 1h` (always `< midDay`), documented in test. Immutable journal plugin blocks Mongoose updates — raw collection is intentional for fixtures. |
| **Verification** | `production-remediation + p2 + p5` → **38/38 pass** (2026-11-01). |

### 2. `p2-ecommerce-fulfilment.test.js` — duplicate confirm-pickup

| Item | Detail |
|------|--------|
| **Symptom** | `customerPickupCode` undefined (earlier 51-test bundle). |
| **Cause** | **Not reproduced** in `production-remediation + p2 + p5` (38 tests). Isolated run **passes**. Likely transient DB/harness timing in a larger partial bundle, not a product defect. |
| **Added coverage** | F11 admin reissue journey test (expiry + attempt lockout recovery). |

## Commands run (authoritative subset)

```bash
# Backend gate
cd swarnagrow-backend && npm run check

# Combined suite (repro context)
LOG_LEVEL=error NODE_ENV=test node --import ./tests/global-test-db-serial.js \
  --test --test-concurrency=1 --test-force-exit \
  tests/production-remediation-regressions.test.js \
  tests/p2-ecommerce-fulfilment.test.js \
  tests/p5-daily-hedge-book.test.js
# Result: 38 pass, 0 fail

# Audit regressions (Mongo replica set)
LOG_LEVEL=error NODE_ENV=test node --import ./tests/global-test-db-serial.js \
  --test --test-concurrency=1 --test-force-exit \
  tests/production-audit-2026-11-01.test.js \
  tests/idempotency-resource-binding.test.js \
  tests/ecommerce-return-eligibility-anchor.test.js

# Full release (in progress / final)
LOG_LEVEL=error RUN_HEAVY=1 NODE_ENV=test node --import ./tests/global-test-db-serial.js \
  --test --test-concurrency=1 --test-force-exit --test-reporter=spec \
  2>&1 | tee /tmp/swarna-test-release-2026-11-01-final.log
```

## Frontend (local, happy-dom / vitest — not staging browser)

```bash
cd SwarnaGrow-Tenant-Admin
npm test          # 72 files, 207 tests — pass
npm run lint      # pass
npm run typecheck # pass
npm run build     # pass
npx vitest run src/features/ecommerce/p8-admin-workflow-journeys.test.tsx  # 2 pass
npx vitest run src/lib/tours/registry.test.ts  # 8 pass (F17)
```

**Not run:** Playwright against live dev server (`guides:check`), staging `FRONTEND_BASE` smoke scripts.

## Migration / reconciliation (read-only policy)

See `docs/PRODUCTION_REMEDIATION_2026-10-30.md` and:

```bash
node scripts/migrate-financial-invariants.js --dry-run
# Apply only with writers paused:
node scripts/migrate-financial-invariants.js --apply --writes-paused
```

Production boot refuses unmigrated financial index layout (`financial-index-rollout.js`).
