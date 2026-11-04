# P8 — Release gate (executed)

**Run date:** 2026-11-01 (agent-run; re-run locally for authoritative evidence).

## Gate checklist

| Check | Command / artifact | Result |
|-------|-------------------|--------|
| P7 compatibility | `docs/P7_CUSTOMER_MOBILE.md` | **Pass** (39-test backend subset + customer vitest) |
| Backend quality | `npm run check` (syntax, route coverage, outbox audit, eslint) | **Pass** |
| Backend heavy suite | `npm run test:release` (`RUN_HEAVY=1`, full `tests/`) | **In progress** — restarted 2026-11-01 after `query-filters` IST fix; see `docs/P8_RELEASE_EVIDENCE.md` and `/tmp/swarna-test-release-2026-11-01.log`. |
| Frontend tests | `npm test` (vitest) in Tenant Admin | **Pass** — 72 files, **207** tests |
| Frontend lint | `npm run lint` | **Pass** (2026-11-01 — exit 0, max-warnings 0) |
| Frontend typecheck | `npm run typecheck` | **Pass** (2026-11-01) |
| Frontend production build | `npm run build` | **Pass** (2026-11-01) |
| Admin browser journeys | Vitest + happy-dom: cancellation, return, COD cash receipt, payments queue | **Pass** — `p8-admin-workflow-journeys.test.tsx`, `ecommerce-record-money-received-panel.test.tsx`, `payments-needing-attention-page.test.tsx` |
| Dependency scan | `npm audit --audit-level=high` (backend) | **Pass** — no high/critical; 12 moderate (transitive) |
| Migration rehearsal | `node scripts/migrate-financial-invariants.js --dry-run` | **Pass** — index readiness report emitted (some indexes `ready: false` in empty test DB; expected until `db:sync-indexes`) |
| Worker shutdown | Static review `src/workers/index.js` | **Pass** — `shutdown()` closes workers, `SIGTERM` / `SIGINT` registered |
| Contract lock | `scripts/check-route-coverage.js` (in `npm run check`) | **Pass** |
| Paired source ZIPs | `npm run package:export` (both repos) | **Blocked** until `test:release` completes with zero failures |

## Browser / Playwright (optional staging)

Not run in this agent session (requires live `FRONTEND_BASE` + API). Staging scripts remain:

- `npm run test:tenant-coverage`
- `npm run test:digital-metals-phase9-browser-smoke`

## After heavy suite is green

```bash
cd swarnagrow-backend && npm run test:release   # unpiped; expect ~3h
cd SwarnaGrow-Tenant-Admin && npm test && npm run typecheck
cd swarnagrow-backend && npm run package:export
cd SwarnaGrow-Tenant-Admin && npm run package:export
```
