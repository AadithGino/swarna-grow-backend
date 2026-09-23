# Swarnagrow backend — V1 release candidate manifest

## Git commit (cut)

**Branch:** `chore/production-hardening-phase-0`

Record at archive time:

```bash
git rev-parse HEAD
```

After the corrective pass (KYC default, mobile patch, payment summary, gold DTO, reversed history, test harness): use the commit tagged in the release zip filename.

## Full regression gate

```bash
npm run check
npm test
```

**Expected (2026-09-24 gate):** 1089 tests, 0 fail, 0 skip (includes corrective-pass regression tests). Run twice back-to-back before shipping; both must be green.

Test DB: `tests/helpers/db.js` calls `model.syncIndexes()` once after MongoMemory replSet connect so unique-index tests are deterministic.

## Build date

2026-09-24 (IST)

## Deployment commands

```bash
npm ci
npm run check
node --env-file=.env scripts/sync-indexes.js --dry-run
node --env-file=.env scripts/sync-indexes.js --apply
# start API / workers per environment runbook
```

After pulling the KYC schema change (no `operations.kycMandatory` default), reset or reseed disposable dev tenants so legacy `settings.requireKycForEnrolment` is not masked by stale `kycMandatory: false`.

## Release archive

Tracked Git content only:

```bash
git archive --format=zip --output swarnagrow-backend-v1-rc.zip HEAD
```

Verify the archive excludes local artifacts (`.env`, `node_modules`, `.git`, keys, coverage, logs, uncommitted WIP).

## Corrective pass (summary)

| Area | Fix |
|------|-----|
| KYC | Drop Mongoose default on `operations.kycMandatory`; resolver honours `settings.requireKycForEnrolment`. |
| Customers | Admin/staff PATCH may change mobile; app self-service profile cannot. |
| Payment summary | Distinct net collected, gross successful, refunded, fully reversed (gross), pending, failed. |
| Gold DTO | Primary `goldAccrual` is net weight; optional `grossGoldAccrual`. |
| History | Reversed payments visible in scheme history / statement rows; totals remain net-only. |
