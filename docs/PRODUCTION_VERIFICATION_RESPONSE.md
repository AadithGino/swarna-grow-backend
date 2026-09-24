# Production verification — V1 backend

**Verdict: READY**

Canonical details (commit, suite totals, archive commands): **`docs/RELEASE_MANIFEST_v1_RC.md`**.

## Gate (actual, 2026-09-24)

| Command | Result |
|---------|--------|
| `npm run check` | Pass |
| `npm run test:release` | **1154** pass, **0** fail, **0** skip |

Product tip before docs: `796e2fc` (`fix: reject unpayable/contradictory plans and invalid dates across all plan paths`).

## Archive SHA-256

| Field | Value |
|-------|--------|
| File | `swarnagrow-backend-v1-rc-155b6f1.zip` |
| Cut from | `155b6f1` (`docs: single accurate release record`) |
| SHA-256 | `ab2416d5eebb17fb65ca9115d48d5835db60906f960f8bf521ed1b07b75c6291` |

## Not covered by the suite alone

Production Atlas/Redis/workers, live payment/SMS/push credentials, and staging soak remain environment-specific.
