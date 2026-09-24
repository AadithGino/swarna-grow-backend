# Production verification — V1 backend

**Verdict: READY**

Canonical record: **`docs/RELEASE_MANIFEST_v1_RC.md`** (references `7922ccd` only; no embedded archive self-hash).

## Gates

| Command | Result |
|---------|--------|
| Plan-validator targeted suite (post Phase A/B) | Pass |
| `npm run check` | Pass |
| Prior `npm run test:release` (closure) | 1154 pass, 0 fail, 0 skip |

## Archive

```bash
sha256sum -c swarnagrow-backend-v1-rc-7922ccd.zip.sha256
```

## Not covered by the suite alone

Production Atlas/Redis/workers, live payment/SMS/push credentials, and staging soak remain environment-specific.
