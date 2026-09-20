# Phase F — Bounded schedulers and reminder caps

## Scheduler inventory (post Phase F)

| Job | Queue | Query pattern | Batch limit | Index | Idempotency |
|-----|-------|---------------|-------------|-------|-------------|
| maturity | scheduler | keyset `{ status, maturityDate≤today, _id }` | `SCHEME_MAINTENANCE_BATCH_SIZE` × `SCHEME_MAINTENANCE_MAX_BATCHES_PER_RUN` | `{ status, maturityDate, _id }` | CAS status transition |
| overdue | scheduler | keyset + `$elemMatch` installments | same | tenant scheme indexes | per-scheme `updateOne` |
| defaulting | scheduler | keyset ACTIVE FIXED | same | `{ status, paymentPattern, _id }` | CAS ACTIVE→DEFAULTED |
| expire-flexible-capacity | scheduler | keyset FLEXIBLE cycles | same | flexible phase index | arrayFilters update |
| apply-flexible-locks | scheduler | keyset FLEXIBLE FLEXIBLE phase | same | flexible index | `applyFlexibleLock` errors ignored when already applied |
| payment-reminders | scheduler | tenant keyset + scheme keyset per tenant | `REMINDER_SCHEME_BATCH_SIZE`, `REMINDER_TENANT_BATCH_SIZE`, `REMINDER_SCHEDULER_MAX_TENANT_BATCHES_PER_RUN` | scheme tenant indexes | dedupe keys + daily quota + scheduler lease |
| grievance-auto-close | scheduler | keyset RESOLVED resolvedAt | same | status indexes | bounded updateMany by id list |
| expire-payments | payments | existing batched expiry service | 100/intent batch | payment indexes | CAS intent expiry |
| phonepe-reconcile | payments | lease + reconcile service | bounded reconcile scan | reconcile indexes | reconcile lease fencing |
| push-broadcast-* | maintenance | broadcast lease recovery | fanout chunk size | broadcast lease indexes | deterministic job ids |
| webhook-reclaim | maintenance | expired processing leases | webhook batch | lease expiry index | CAS reclaim |
| dispatch-reclaim | maintenance | dispatch + legacy outbox | `DISPATCH_RECLAIM_BATCH_SIZE` | dispatch lease indexes | CAS |
| export-artifact-cleanup | maintenance | export expiry service | export batch | export status index | idempotent purge |

## Queue isolation

| Queue | Concurrency | Workload |
|-------|-------------|----------|
| messages | 40 (config) | customer notifications / FCM |
| webhooks | 10 | PhonePe / WhatsApp ingress |
| outbox | 20 | payment.succeeded fan-out |
| payments | 2 | expiry + gateway reconcile |
| scheduler | 1 | scheme transitions + reminders |
| maintenance | 2 | broadcast fan-out, reclaim, export cleanup |
| exports | 2 | report generation |

Latency-sensitive payment/auth/API paths are **not** on scheduler/maintenance workers.

## Reminder quota semantics

- Document: `ReminderDailyQuota` keyed by `tenantId:customerId:channel:dayYmd`.
- **Product invariant:** reminder calendar day, scheduler lease date, and send windows always use **`Asia/Kolkata`** (`REMINDER_PRODUCT_TIMEZONE`). Per-tenant `sendWindow.timezone` overrides that differ from India are ignored (not server UTC).
- `APP_TIMEZONE` defaults to `Asia/Kolkata` and must remain a valid IANA zone when set.
- **Consumption:** quota increments only after atomic `$lt cap` claim succeeds **and** `claimReminderMessage` inserts a new message.
- **Release:** if message claim loses dedupe race, quota decrements (no net consumption).
- **Opt-out / channel eligibility** evaluated before quota claim.
- **Failed/suppressed** reminders (ineligible channel, quota denied) do **not** consume quota.
- Push and WhatsApp caps are independent (`maxPushPerCustomerPerDay`, `maxWhatsAppPerCustomerPerDay`).

## Safe deployment order

1. Deploy **API** (readiness exposes worker role heartbeats; production `/ready` fails until roles are live).
2. Deploy **workers** and confirm processes subscribe to `scheduler`, `payments`, `maintenance`, and legacy queues **before** any scheduler registration runs.
3. Verify Redis keys `swarnagrow:ops:worker-heartbeat:scheduler` and `:payments` are refreshed (TTL 45s).
4. Run **scheduler registration** (`node src/schedulers/index.js`) or start the scheduler sidecar — blocked in production (or when `SCHEDULER_REQUIRE_WORKER_ROLES=true`) until both roles heartbeat.
5. Sync indexes add-only (`node scripts/sync-indexes.js`).
6. Run `node scripts/reconcile-legacy-message-send-outbox.js` if legacy outbox backlog exists.

Missing scheduler/payments workers must **not** pass production readiness — repeatable jobs must not accumulate with no consumers.

## Rollback

1. Stop scheduler registration / cron that runs `src/schedulers/index.js`.
2. Revert worker deployment; keep workers draining existing Redis jobs if possible.
3. Revert API last if needed; old maintenance queue jobs remain on Redis until drained — run dual workers briefly if needed.
4. Do **not** drop Phase F indexes on rollback.

## Phase G1 — Cross-run maintenance rotation and queue retries

### Persistent scan cursors (Redis)

| Stream key suffix | Job | TTL env |
|-------------------|-----|---------|
| `swarnagrow:maintenance:cursor:v1:defaulting` | defaulting | `MAINTENANCE_CURSOR_TTL_SEC` (default 604800) |
| `swarnagrow:maintenance:cursor:v1:flexible_lock` | apply-flexible-locks | same |
| `swarnagrow:maintenance:cursor:v1:payment_expiry_intent` | expire-payments (intents) | same |
| `swarnagrow:maintenance:cursor:v1:payment_expiry_link` | expire-payments (links) | same |

Reminder cursors (`swarnagrow:reminder:cursor:…`) are **not** reused for these jobs.

**Behavior:** each invocation reads the cursor, processes up to `*_MAX_BATCHES_PER_RUN` keyset batches, writes the last scanned `_id` when more work remains, clears the cursor at end-of-range, and allows **at most one wrap** (cursor reset to start) per invocation. Crash before cursor write may rescan a batch; CAS/idempotency prevents duplicate business effects.

**Rollback / reset:** delete the relevant Redis key(s) above to restart scanning from the beginning. Safe at any time; may reprocess rows idempotently.

**Production:** cursor operations require Redis (`MAINTENANCE_CURSOR_REDIS_UNAVAILABLE` if missing). Invalid cursor values are cleared automatically.

### Phase G1.1 — Scan lease ownership (Redis)

| Lease key suffix | Stream |
|------------------|--------|
| `swarnagrow:maintenance:lease:v1:defaulting` | defaulting |
| `swarnagrow:maintenance:lease:v1:flexible_lock` | flexible-lock |
| `swarnagrow:maintenance:lease:v1:payment_expiry_intent` | payment intents |
| `swarnagrow:maintenance:lease:v1:payment_expiry_link` | payment links |

**Acquire:** `SET` with `NX` and `PX` (`MAINTENANCE_SCAN_LEASE_MS`, default 120000). Value is a random owner token. Active leases are never stolen.

**During scan:** lease is refreshed between batches. Cursor write/clear and lease release use Lua scripts that compare the owner token.

**Contention:** a second concurrent invocation gets `leaseBusy` (metric `maintenance.scan.lease_busy`) and does not run batches or mutate the cursor.

**Recovery:** if a process crashes, the lease expires and a later run reclaims it. Cursor keys may still point mid-range; scanning continues idempotently. Lost ownership mid-run stops cursor updates (metric `maintenance.scan.lease_lost`).

**Rollback:** delete lease key(s) and/or cursor key(s) for the stream to reset. Safe; may rescan idempotently.

### BullMQ repeatable job retries

| Queue | Attempts env | Backoff env | Default |
|-------|--------------|-------------|---------|
| scheduler | `SCHEDULER_JOB_ATTEMPTS` | `SCHEDULER_JOB_BACKOFF_MS` | 3 / 30s exponential |
| payments | `PAYMENTS_JOB_ATTEMPTS` | `PAYMENTS_JOB_BACKOFF_MS` | 5 / 15s exponential |
| maintenance | `MAINTENANCE_JOB_ATTEMPTS` | `MAINTENANCE_JOB_BACKOFF_MS` | 5 / 15s exponential |

Registered via `upsertJobScheduler(id, repeat, { name, data, opts })` where `opts` includes `attempts` and `backoff: { type: "exponential", delay }`.

**After exhaustion:** failed job records remain in Redis (`removeOnFail: 5000` on queues) for inspection/replay; business handlers must stay idempotent on retry.

**Metrics (low cardinality):** `maintenance.scan.continuation_scheduled`, `maintenance.scan.wrapped`, plus existing `scheduler.batch.*` and `payment.expiry.*` counters.

**Staging not verified here:** index explain at production scale and deploy-order drill remain staging-only gates.

## Phase E dispatch fairness (related)

- Tenant rotation cursor: `swarnagrow:dispatch:tenant-rotation:<collection>` in Redis.
- Bounded tenant page: `MESSAGE_DISPATCH_TENANT_PAGE_SIZE` (default 32).
- Bounded per-tenant query concurrency: `MESSAGE_DISPATCH_TENANT_QUERY_CONCURRENCY` (default 4).
