# SwarnaGrow backend — V1 release record

**Verdict: READY** for controlled V1 backend cut (targeted plan-validator gate green; prior full `test:release` on closure tip).

This file is the single accurate release record. It supersedes older READY/NOT READY notes and expected counts. Do not embed an archive self-hash here — verify the zip with the companion `.sha256` file.

## Final commit

| Field | Value |
|-------|--------|
| Branch | `chore/production-hardening-phase-0` |
| Tip (short) | `7922ccd` |
| Tip message | `fix: require customer-chosen bounds; advance-enabled/zero guard; reject cap on flexible plans` |

## Plan-validation correctness (validator-only)

| Phase | Commit | Summary |
|-------|--------|---------|
| A | `679cf79` | Per-transaction cap decision table; min-cycle-cap satisfiability |
| B | `7922ccd` | Customer-chosen bounds; advance-enabled/zero; reject txn cap on flexible |

Targeted gate (post B): `plan-satisfiability*`, `plan-cross-field*`, `plan-phase1*`, `plan-patch-merge*`, `flexible-plan-duration` + `npm run check` — pass.

## Prior full regression gate (closure tip)

| Metric | Result |
|--------|--------|
| Command | `npm run test:release` |
| Pass / fail / skip | **1154** / **0** / **0** |
| Date | 2026-09-24 |

Default `npm test` still gates two heavy 15k scans behind `RUN_HEAVY`; `test:release` runs them.

Test DB: `tests/helpers/db.js` calls `model.syncIndexes()` once after MongoMemory replSet connect.

## Release archive

Named for product tip `7922ccd` (no embedded self-hash):

```bash
git archive --format=zip -o swarnagrow-backend-v1-rc-7922ccd.zip HEAD
sha256sum swarnagrow-backend-v1-rc-7922ccd.zip > swarnagrow-backend-v1-rc-7922ccd.zip.sha256
```

Tracked Git content only — excludes `.env`, `node_modules`, `.git`, keys, coverage, logs, uncommitted WIP.

## Deploy checklist

```bash
npm ci
npm run check
node --env-file=.env scripts/sync-indexes.js --dry-run
node --env-file=.env scripts/sync-indexes.js --apply
```

## Environment-dependent (not covered by suite alone)

- Production MongoDB Atlas + Redis + BullMQ workers
- Live PhonePe / MSG91 / FCM credentials and webhook ingress
- Staging soak / broadcast load on real hardware
