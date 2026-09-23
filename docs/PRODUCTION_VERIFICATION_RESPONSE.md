# Production verification — V1 RC backend (2026-09-24)

## Verdict: **READY** for controlled V1 backend cut (unit + integration gate)

This document supersedes the 2026-09-18 **NOT READY** note for the **backend repository** at the V1 RC commit. Staging-scale gates (15k broadcast, live FCM/PhonePe) remain environment-specific and are tracked separately.

## Backend gate (required before deploy)

```bash
npm run check
npm test   # expect 1089 pass, 0 fail, 0 skip — run twice
```

Archive: `git archive --format=zip HEAD` from the RC commit (see `docs/RELEASE_MANIFEST_v1_RC.md`).

## Corrective pass pinned by regression tests

- KYC mandatory resolution with persisted tenants (legacy `requireKycForEnrolment`).
- Admin/staff customer mobile PATCH; self-service mobile immutable.
- Payment list summary gross/net/refunded/reversed semantics.
- Gold accrual DTO net weight after partial refund.
- Reversed payments in history without inflating totals.

## Still environment-dependent (not covered by `npm test` alone)

- Production MongoDB Atlas + Redis + BullMQ worker fleet.
- Live PhonePe / MSG91 / FCM credentials and webhook ingress.
- Full tenant load and broadcast soak on staging hardware.
