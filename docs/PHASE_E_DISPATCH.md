# Phase E — Queue dispatch, fairness, and recovery

## Design summary

Dispatch uses **recoverable lease state** on Mongo documents (`dispatchState`, `dispatchLeaseOwner`, `dispatchLeaseExpiresAt`, `dispatchAttemptCount`, `lastDispatchAttemptAt`, `dispatchedAt`) instead of permanent `enqueuedAt` exclusion.

Flow per record:

1. **Claim** (CAS): `PENDING` / expired `DISPATCHING` / stale `DISPATCHED` → `DISPATCHING` with lease.
2. **Enqueue** BullMQ with deterministic `jobId` (= document `_id`).
3. **Ack** (CAS): owner must match → `DISPATCHED` + `dispatchedAt`, lease cleared.
4. On queue-add failure → **release** lease to `PENDING`.
5. Maintenance **`dispatch-reclaim`** (60s): bounded CAS reclaim of expired dispatch leases; includes broadcast fan-out recovery and push device delivery claim reclaim.

**Message authority:** `Message` rows in `QUEUED` are the sole dispatch source for customer notifications. Redundant `message.send` outbox rows are no longer created; legacy rows are completed as no-ops in the outbox worker. Payment/outbox topics (`payment.succeeded`, etc.) remain on the outbox queue.

**Legacy orphan closure:** `message.send` rows without a `Message` are terminalized as `COMPLETED` with `error=LEGACY_MESSAGE_SEND_ORPHAN` (worker + bounded reconcile script `scripts/reconcile-legacy-message-send-outbox.js` with `--dry-run`). Rows are retained for audit; dispatch never enqueues `message.send`.

**Fairness:** `fetchFairDispatchCandidates` loads up to `MESSAGE_DISPATCH_TENANT_BATCH_SIZE` rows **per tenant** (indexed query), then round-robins across tenants up to `MESSAGE_DISPATCH_BATCH_SIZE`. Large tenants cannot monopolize a global 2,000-row window.

## Rollout order

1. Deploy code + `npm run sync:indexes` (add-only indexes).
2. Run `node scripts/migrate-dispatch-lease.js` (restartable).
3. Roll API/dispatcher/worker replicas (mixed version OK if migration ran — legacy `enqueuedAt` eligible only when stale).
4. Verify `dispatch-reclaim` maintenance job registered.

## Rollback order

1. Roll back to previous app version (old dispatcher still understands `enqueuedAt`; new fields ignored).
2. Optional: set `dispatchState: PENDING` and unset `dispatchedAt` on stuck `QUEUED` messages if needed (scripted, not automatic).
3. Do **not** drop Phase E indexes in rollback.

## Crash boundaries

| Boundary | Guarantee |
|----------|-----------|
| Before queue add | Lease expires → reclaim → redispatch; same deterministic job id |
| After queue add, before ack | Reclaim → redispatch; BullMQ dedupes duplicate add |
| After ack, worker not run | Stale `DISPATCHED` reclaim → redispatch |
| During provider call | Phase D per-device delivery claims + message CAS finalization |
| After provider success, before DB update | Delivery claim CAS; stale worker cannot finalize message |

No permanently lost queued work; no duplicate terminal customer delivery from dispatch alone (worker idempotency unchanged from Phase D).
