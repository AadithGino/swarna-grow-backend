# SwarnaGrow backend — V1 release record

**Verdict: READY** for controlled V1 backend cut (unit + integration gate with heavy tests).

This file is the single accurate release record. It supersedes older READY/NOT READY notes and expected counts.

## Final commit

| Field | Value |
|-------|--------|
| Branch | `chore/production-hardening-phase-0` |
| Commit (short) | `796e2fc` |
| Commit (full) | `796e2fc985939fa2f9c231ad868806173d21e0be` |
| Tip message | `fix: reject unpayable/contradictory plans and invalid dates across all plan paths` |

Docs commit that published this record is immediately after `796e2fc` on the same branch (`docs: single accurate release record`). Archive is cut from that docs HEAD.

## Full regression gate (actual)

```bash
npm run check   # syntax + route coverage + eslint — passed 2026-09-24
npm run test:release   # RUN_HEAVY=1, concurrency 1
```

| Metric | Result |
|--------|--------|
| Tests | **1154** |
| Pass | **1154** |
| Fail | **0** |
| Skip | **0** |
| Cancelled | **0** |
| Duration | ~2359 s (~39 min) |
| Date | 2026-09-24 |

Default `npm test` still gates two heavy 15k scans behind `RUN_HEAVY`; `test:release` runs them. Both heavy tests passed in this gate.

Test DB: `tests/helpers/db.js` calls `model.syncIndexes()` once after MongoMemory replSet connect.

## Closure phases (product commits)

| Phase | Commit | Summary |
|-------|--------|---------|
| 1 | `200ee99` | Enrolment first-payment uses in-tx result end-to-end |
| 2 | `b2fa68d` | Staff-update whitelist / mass-assignment block |
| 3 | `3a0fcb2` | Cash custody lock on settle/cancel/resolve/reversal |
| 6 | `22e9b92` | One-active DTO shared resolver; staff token tenant/type bind |
| 5 | `3e42a88` | Strict DTOs: reverse reason, KYC verify, handover transitions |
| 4 | `796e2fc` | Plan satisfiability, calendar dates, branch referential checks |
| 7 | (this docs commit) | Single accurate release record |

## Release archive

```bash
git archive --format=zip --output swarnagrow-backend-v1-rc-$(git rev-parse --short HEAD).zip HEAD
shasum -a 256 swarnagrow-backend-v1-rc-*.zip
```

**Archive SHA-256:** recorded in `docs/PRODUCTION_VERIFICATION_RESPONSE.md` after `git archive` from the docs HEAD.

Tracked Git content only — excludes `.env`, `node_modules`, `.git`, keys, coverage, logs, uncommitted WIP.

## Deploy checklist

```bash
npm ci
npm run check
node --env-file=.env scripts/sync-indexes.js --dry-run
node --env-file=.env scripts/sync-indexes.js --apply
# start API / workers per environment runbook
```

## Environment-dependent (not covered by `npm run test:release`)

- Production MongoDB Atlas + Redis + BullMQ workers
- Live PhonePe / MSG91 / FCM credentials and webhook ingress
- Staging soak / broadcast load on real hardware
