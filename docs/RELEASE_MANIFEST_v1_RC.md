# SwarnaGrow backend — V1 release record

**Verdict: READY** for controlled V1 backend cut.

This file is the single accurate release record. Do not embed an archive self-hash here — verify the zip with the companion `.sha256` file.

## Final commit

| Field | Value |
|-------|--------|
| Branch | `chore/production-hardening-phase-0` |
| Tip (short) | `8c66778` |
| Tip message | `docs: point release record at MSG91 tip` |

## MSG91 live OTP delivery

| Phase | Commit | Summary |
|-------|--------|---------|
| 1 | `da2fcb4` | MSG91 env config + production validation |
| 2 | `7020cf1` | MSG91 Flow SMS client |
| 3 | `e1e068c` | Wire delivery into OTP provider lifecycle |
| fixture | `cf70448` | Flexible extension planBody fixture bounds |

App still owns OTP lifecycle (generate/hash/TTL/attempts/otpId); MSG91 only delivers via DLT Flow template.

## Full regression gate (actual)

| Metric | Result |
|--------|--------|
| Command | `npm run test:release` |
| Pass / fail / skip | **1175** / **0** / **0** |
| Date | 2026-09-25 |
| `npm run check` | Pass |

## Release archive

Named for tip `8c66778` (no embedded self-hash):

```bash
git archive --format=zip -o swarnagrow-backend-v1-rc-8c66778.zip HEAD
sha256sum swarnagrow-backend-v1-rc-8c66778.zip > swarnagrow-backend-v1-rc-8c66778.zip.sha256
```

Tracked Git content only — excludes `.env`, `node_modules`, `.git`, keys, coverage, logs, uncommitted WIP.
