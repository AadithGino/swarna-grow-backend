# Observability and operational readiness

Phase 9 of the production hardening program. Complements [OPERATIONS.md](./OPERATIONS.md).

## Process layout (recommended)

Run **separate process groups** so bulk work cannot starve financially critical paths:

| Group | Entrypoint | Queues / work |
|-------|------------|----------------|
| API | `npm start` | HTTP only; no BullMQ consumers |
| Messaging workers | `npm run worker` (scale horizontally) | `messages`, `outbox` — FCM/WhatsApp sends |
| Webhook workers | Same image, dedicated replicas | `webhooks` — PhonePe/WhatsApp ingress |
| Maintenance | Same image, low concurrency | `maintenance` — reminders, broadcast fan-out, reconcile, expiry |
| Exports | Same image, `exports` worker concurrency 2 | Large CSV/PDF generation |
| Scheduler | `npm run scheduler` | **One** active scheduler per environment (BullMQ job registration) |

Tune BullMQ concurrency in `src/workers/index.js` when splitting deployments (e.g. webhook-only pods with higher webhook concurrency, zero export workers).

## Readiness (`GET /health/ready`)

Production **ready** requires:

- MongoDB reachable
- Redis reachable (`REDIS_REQUIRED=true`)
- Recent worker heartbeat (Redis)
- Queue health within thresholds (see env below)

Response includes:

- `configuration` — provider mode and credential *presence* (no secrets)
- `queues` — BullMQ job counts, oldest queued message age, webhook Mongo backlog
- `queueWarnings` — e.g. `MESSAGE_QUEUE_LAG`, `WEBHOOK_DEAD_LETTER`
- `metrics` — in-process counters/durations since process start (API vs worker pods differ)

### Readiness thresholds (env)

| Variable | Default | Meaning |
|----------|---------|---------|
| `READINESS_MESSAGE_QUEUE_LAG_MS` | 300000 | Oldest `Message` in `QUEUED` |
| `READINESS_WEBHOOK_QUEUE_WAITING_MAX` | 500 | BullMQ `webhooks` waiting jobs |
| `READINESS_WEBHOOK_EVENT_BACKLOG_MAX` | 1000 | `WebhookEvent` in `QUEUED` |
| `READINESS_WEBHOOK_DEAD_LETTER_MAX` | 50 | `WebhookEvent` in `DEAD_LETTER` |

Metrics use **fixed low-cardinality names** only (`fcm.outcome.*`, `phonepe.reconcile.*`, `webhook.*`, etc.). Never attach tenant id, phone, token, or order id as metric labels; use structured logs for traceability.

## Operator CLI

```bash
npm run ops:inspect
```

Prints queue snapshot, evaluation, oldest queued message, outbox backlog, latest webhook dead letters, and stale gateway `PENDING` payments.

## Dead letter and replay

1. List dead letters: tenant admin `GET .../messaging/dead-letter` or Mongo `WebhookEvent` where `status = DEAD_LETTER`.
2. Fix root cause (credentials, payload bug, downstream DB).
3. Requeue: `POST .../messaging/dead-letter/:id/requeue` (idempotent replay via `replayWebhookEvent` + new BullMQ job).

Webhook processing is idempotent for PhonePe success (transaction id) and duplicate `(tenantId, provider, providerEventId)`.

## Index rollout discipline

- **Do not** call `syncIndexes()` on API startup.
- Define indexes on Mongoose models; apply in maintenance window:

```bash
npm run db:sync-indexes
```

Before adding **unique** indexes (webhooks, device registration, broadcast message idempotency):

1. Run aggregation queries to find duplicate keys in staging/production.
2. Repair duplicates (migration scripts under `scripts/`) before sync.
3. Verify query plans after indexes are built; only then document obsolete index removal.
