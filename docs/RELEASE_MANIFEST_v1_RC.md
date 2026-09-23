# Swarnagrow backend — controlled V1 release candidate manifest

## Git commit

Record the exact commit after checkout:

```bash
git rev-parse HEAD
```

Release-blocker round (Phases 1–8 + admin/refund/KYC pass) is on branch `chore/production-hardening-phase-0`.
Record `git rev-parse HEAD` at cut time (includes commits through release-blocker phases).

## Test counts

- Phase 6.1 targeted tests: 17 (gold accrual report, plan benefit liability, maturity projection).
- Full regression gate: run once after Phase 6.1 production changes:

```bash
npm test
```

Document the final pass/fail count from that single run in your release notes.

## Build date

2026-09-23 (IST)

## Deployment commands

```bash
npm ci
npm run check
node --env-file=.env scripts/sync-indexes.js --dry-run
node --env-file=.env scripts/sync-indexes.js --apply
# start API / workers per environment runbook
```

## Release archive

Produce from tracked Git content only (no working-tree folder zip):

```bash
git archive --format=zip --output swarnagrow-backend-v1-rc.zip HEAD
```

Verify the archive excludes local artifacts (`fix.md`, `.env`, `node_modules`, `.git`, keys, coverage, logs).

## Phase 6.1 corrections (summary)

- Gold accrual report: net INSTALLMENT/FREE_WINDOW payments minus REVERSAL; weighted avg rate; `moneyPaiseFromWeightMg` liability.
- Plan stats benefit liability: per-scheme `computeConfiguredBenefitPaise` from ledger net paid; MATURED unredeemed included; REDEEMED/CLOSED excluded.
- Maturity projection: shared helper + service; no inline float math; flexible ONE_FREE_INSTALLMENT returns zero benefit.
