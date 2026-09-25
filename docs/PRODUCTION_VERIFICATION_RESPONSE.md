# Production verification — V1 backend

**Verdict: READY**

Canonical record: **`docs/RELEASE_MANIFEST_v1_RC.md`** (references `8c66778` only; no embedded archive self-hash).

## Gates

| Command | Result |
|---------|--------|
| `npm run check` | Pass |
| `npm run test:release` | **1175** pass, **0** fail, **0** skip |

## Archive

```bash
sha256sum -c swarnagrow-backend-v1-rc-8c66778.zip.sha256
```
