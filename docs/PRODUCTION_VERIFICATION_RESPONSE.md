# Production verification follow-up (2026-09-18)

## Verdict: **NOT READY** (repo-wide) · **Phase A/B: conditional pass on code + tests**

Phases D–I and the real 15k staging gate remain open. Phase A/B PhonePe blockers below were implemented with Mongo replica-set integration tests (80 hardening / 232 full suite, 0 skipped).

## Phase A/B — transaction boundaries

| Flow | Single Mongo transaction |
|------|---------------------------|
| Gateway **success** | `finalizeGatewaySuccess()` → `withTransaction` → `recordPayment({ session })` (Payment, LedgerEntry, sequence, Scheme, OutboxEvent, AuditEvent) + `repairIntentAndLink({ session })` for PaymentIntent/PaymentLink. |
| Gateway **terminal failure** | `applyTerminalGatewayFailure()` → Payment FAILED, PaymentIntent FAILED, PaymentLink EXPIRED, Scheme version bump, Outbox `payment.gateway.failed`, AuditEvent. |
| Full **refund reversal** | `processPhonePeRefundWebhook` COMPLETED (full amount) → Payment REVERSED, LedgerEntry REVERSAL, Scheme projection, PaymentRefund, AuditEvent. |

**Not in one transaction (remaining risk):** amount-mismatch review path in `finalizeGatewaySuccess` (alert + payment review status) before success txn.

## Implemented in this pass

| Phase | Change |
|-------|--------|
| **A** | Session-plumbed `recordPaymentInSession`; atomic success + terminal failure; test fault hooks + rollback tests. |
| **B** | Expiry provider branching (COMPLETED / TERMINAL / DEFER / transient); reconcile exhaustion + `forceReplay` manual reconcile + lease claims; webhook tenant guard; refund validation/alerts/tenant scope. |
| **C (partial)** | Token reassignment pulls legacy embedded tokens from displaced owners; no legacy fallback when any `DeviceRegistration` row exists; push worker treats `SENT`/`READ` as terminal. |
| **E (partial)** | Stale `enqueuedAt` reclaim for queued messages (`MESSAGE_DISPATCH_STALE_MS`). |
| **H** | `scripts/sync-indexes.js` uses `diffIndexes()` + `createIndexes()` only; drops require `--apply-drops`. |

## Still open (release blockers)

- Distributed FCM rate limiting and non-blocking 429 retries (Phase D).
- Terminal failure / refund atomicity and full PhonePe failure-injection tests (Phase A/B).
- Paginated maintenance jobs, report streaming/limits wiring, webhook tenant rejection (Phases F/G/B).
- Multi-tenant scoping audit across all workers (Phase I).
- **Staging gate:** full 15k broadcast with Mongo replica set, Redis, BullMQ workers, and FCM/PhonePe emulators — not satisfied by `npm run load:hardening` alone.

## Gates (run locally)

```bash
npm run check
npm run test:hardening
npm test
npm run db:sync-indexes:dry-run
```

Record outputs in this file when re-verifying before a production claim.
