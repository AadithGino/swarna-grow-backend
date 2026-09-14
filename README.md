# SwarnaGrow backend

Production-oriented JavaScript implementation of the SwarnaGrow v1.2 API contract. It serves the platform console, tenant-admin portal, staff app API, customer app API, public payment/signup flows, provider webhooks, exports, and background processing.

## Stack

- Node.js 22+, ECMAScript modules, Express 5
- MongoDB with Mongoose; financial writes use replica-set transactions
- Redis + BullMQ for webhooks, messages, exports, outbox work, and scheduled maintenance
- Zod request/environment validation, Argon2id passwords, rotating refresh tokens, JWT access tokens
- Pino structured logs, Helmet, explicit CORS, throttling, trace IDs, idempotency keys, optimistic versions
- PhonePe, Meta Cloud API, object storage, OTP, and push provider adapters; mock mode is the default

No TypeScript or Docker configuration is included.

## Project layout

```text
src/
  config/          validated environment, MongoDB, Redis, logging
  constants/       frozen runtime enums and permissions
  controllers/     HTTP translation only
  integrations/    external provider adapters (mock/live)
  lib/             errors, money, dates, cursors, transactions, crypto
  middlewares/     auth, tenant scope, validation, idempotency, errors
  models/          Mongoose schemas and indexes
  queues/          BullMQ queues and transactional-outbox dispatcher
  routes/          versioned API routers by consumer/domain
  schedulers/      repeatable BullMQ job registration
  services/        business rules and transaction boundaries
  validators/      Zod API contracts
  workers/         webhook, messaging, export, outbox, maintenance jobs
tests/              unit and HTTP contract tests
scripts/            syntax validation and seed utilities
docs/               decisions, operations, and route coverage
```

## Run locally

MongoDB must run as a replica set because payment, ledger, enrolment, redemption, and audit changes are atomic transactions. Redis may be omitted only for synchronous API development; queued features remain pending until Redis, a worker, and the scheduler are running.

```bash
npm install
cp .env.example .env
npm run seed
npm run dev
```

In separate processes:

```bash
npm run worker
npm run scheduler
```

The scheduler command registers repeatable jobs and exits. The API starts the outbox dispatcher whenever Redis is available.

Default API base: `http://localhost:4000/api/v1`. Health endpoints are `/health` and `/health/ready`.

## Provider mode

`PROVIDER_MODE=mock` keeps OTP, payment, WhatsApp, object-storage, and push flows deterministic without vendor credentials. Switch to `live` and configure the corresponding environment values plus tenant-specific encrypted integration credentials through the platform endpoints.

Integration secrets are encrypted with AES-256-GCM before MongoDB persistence and excluded from normal queries. Use a secret manager to inject `INTEGRATION_ENCRYPTION_KEY` in production and keep it stable across API/workers.

## Process topology

- **API** — stateless HTTP processes behind a load balancer.
- **Worker** — BullMQ consumers; scale message/webhook workers independently from exports.
- **Scheduler registration** — run during deployment or as a controlled release job.
- **MongoDB** — production replica set with backups and majority write concern.
- **Redis** — durable managed Redis with persistence and failover for production queues.

## Important domain guarantees

- Paise and milligrams are safe integers; no floating-point currency is stored.
- Ledger and audit collections reject updates and deletes at the model layer.
- Provider callbacks are raw-body verified, deduplicated, persisted, and processed asynchronously.
- Gateway initiation creates one pending `Payment`; only verified completion converts it and posts a ledger entry.
- Flexible contributions are optional. Unused monthly allowance does not carry forward; paid money never expires.
- Flexible schemes are excluded from dues, overdue/default logic, and automatic due reminders.
- Fixed schemes do not mature before their contractual maturity date even when fully paid.
- Export requests allow at most five years and stream without a row cap.

See [locked decisions](docs/LOCKED_BUSINESS_DECISIONS.md) and [operations](docs/OPERATIONS.md).

## Verification

```bash
npm run check
npm test
npm run test:coverage
```

The tests cover integer money behavior, immutable enums, flexible payable limits, HTTP error envelopes, health routes, and literal-route precedence.

## Deployment checklist

1. Replace every default secret and set `NODE_ENV=production`.
2. Use a MongoDB replica set, Redis persistence/failover, TLS, private networking, and least-privilege accounts.
3. Configure exact CORS origins and reverse-proxy forwarding.
4. Configure live provider credentials, callback URLs, Meta templates (including `PAYMENT_SUCCESS_TEXT_FALLBACK`), and object storage.
5. Run API and worker as separate supervised processes; register schedulers once per deployment.
6. Send structured logs to centralized storage and alert on readiness, dead-letter webhooks, failed exports, queue lag, and pending gateway age.
7. Back up MongoDB and test restore procedures before go-live.

