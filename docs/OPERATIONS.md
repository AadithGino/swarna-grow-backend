# Operations guide

## Services

| Process | Command | Horizontal scaling | Required dependencies |
|---|---|---:|---|
| API | `npm start` | Yes | MongoDB; Redis in production |
| Worker | `npm run worker` | Yes | MongoDB and Redis |
| Scheduler registration | `npm run scheduler` | Run once per release | Redis |

## Scheduled work (Asia/Kolkata)

| Job | Schedule | Effect |
|---|---|---|
| Maturity | 00:05 daily | Moves eligible schemes at/after contractual maturity; never early |
| Fixed overdue | 00:10 daily | Updates fixed installments only |
| Flexible capacity close | 00:15 daily | Removes unused past-cycle capacity; does not change ledger money |
| Fixed reminders | 09:30 daily | Queues fixed due/overdue messages only |
| Grievance auto-close | Hourly | Closes resolved grievances after seven days |
| Payment expiry | Every minute | Releases stale intent reservations and expires links |

## Failure recovery

- Provider requests use finite timeouts and surface `DEPENDENCY_UNAVAILABLE`.
- BullMQ retries use exponential backoff. Permanently failed webhook events remain queryable from platform and dead-letter routes.
- The transactional outbox prevents successful payment commits from losing downstream messages.
- Webhook idempotency is enforced by `(provider, providerEventId)`; request idempotency uses tenant, actor, route, and key.
- Gateway amount mismatches never post a ledger credit and are parked for manual review.
- A verified late gateway success is never discarded. It is allocated when possible or recorded as `UNALLOCATED_PENDING_REVIEW`.

## Security notes

- Do not put secrets in request logs, error details, or exports.
- Rotate JWT secrets with a controlled session invalidation plan.
- Rotating refresh tokens detect reuse and revoke the entire token family.
- Tenant integration credentials are encrypted at rest by the application and excluded from default projections.
- Place public, app, admin, platform, and webhook rate limits behind an upstream WAF for defense in depth.

## Monitoring signals

- `/health/ready` status and latency
- HTTP error rate by `error.code` and route
- MongoDB transaction retries/failures and connection pool saturation
- BullMQ waiting/failed/dead-letter counts and oldest-job age
- `PENDING` payment age, webhook age, late success, and amount mismatch counts
- Message delivery failures and fallback-template usage
- Export duration, row count, failure rate, and storage upload errors

