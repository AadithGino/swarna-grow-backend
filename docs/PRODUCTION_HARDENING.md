# Production hardening tracker

Living document for the [SwarnaGrow production hardening program](../SwarnaGrow_Cursor_Production_Hardening_Prompt_2026-09-18.md). Update after each phase.

**Branch (Phase 0):** `chore/production-hardening-phase-0`  
**Baseline date:** 2026-09-18 (IST)

---

## Phase 0 — Baseline and safety inventory (complete)

### Baseline commands

| Command | Result (2026-09-18) | Notes |
|--------|---------------------|--------|
| `npm run check` | **PASS** | 207 JS files syntax OK; 279 contract routes covered; ESLint clean |
| `npm test` (full suite) | **Unreliable baseline (~10.6 min, exit 0)** | 2026-09-18 run: first block reported **27 subtests pass** (~632s), then **~78 test files** failed with *“Promise resolution is still pending but the event loop has already resolved”* (likely open handles / DB connections after early files). Log: `/tmp/swarnagrow-test-baseline.txt`. **Treat as red for Phase 1 gate until a clean full run passes.** |
| Targeted sample | **PASS** (20/20) | `reminder-config`, `env-production-secrets`, `phonepe-provider` (isolated run) |

No business logic was changed in Phase 0.

### Secret and artifact inventory

| Check | Status |
|-------|--------|
| `.env` tracked in Git | **No** — ignored via `.gitignore` (`!.env.example` only) |
| `.env` in Git history | **No commits** on `.env` (spot check) |
| Tracked env template | **Only** `.env.example` (placeholders, no live secrets) |
| PEM / service account files in repo | **None found** in tree (excluding `node_modules`) |
| Local `.env` on disk | Present for dev — **do not commit** |
| Zip archives (parent folder) | `swarnagrow-backend-source-20260918.zip` **includes** `swarnagrow-backend/.env` — **rotate any secrets** if that archive was shared |
| Full zip with `node_modules` + `.git` | Exists — treat as dev backup only |

**Operator actions if credentials were distributed:**

- Rotate JWT secrets, `INTEGRATION_ENCRYPTION_KEY`, PhonePe, WhatsApp, FCM service account, S3 keys, and seed passwords **outside** the codebase.
- Do not embed secrets in this doc, tests, or fixtures.

### Uncommitted work context (pre–Phase 1)

Working tree contains in-progress FCM / reminders / push-broadcast work (not part of Phase 0). Phase 1+ should either commit that on a feature branch or stash before hardening commits.

---

## Completed code changes (by phase)

| Phase | Status | Summary |
|-------|--------|---------|
| 0 | Done | Baseline + this document only |
| 1 | Done | Production env fail-closed, bounded tunables, readiness config, boot PhonePe tenant guard, FCM no fake success in live mode |
| 2 | Done | FCM outcomes/retry, tenant Firebase config, DeviceRegistration + per-device delivery, migration script |
| 3 | Done | Crash-safe broadcast fan-out, leases, outbox upserts, fair dispatcher, batched list stats |
| 4 | Done | Reminder scheduler pagination, dedupe upserts, Redis lease, channel independence |
| 5 | Done (core) | PhonePe callback classification, tenant-scoped webhook dedupe IDs, `finalizeGatewaySuccess`, processor state machine, client cache invalidation on integration update |
| 6 | Done (core) | PhonePe reconciliation job, batched expiry with provider check, `PaymentRefund` + refund webhooks, manual reconcile API |
| 7 | Done (core) | Webhook body limits, Redis rate limits, digest-only signature failures, processing leases + reclaim, TTL `purgeAt`, in-process webhook metrics on readiness |
| 8 | Done (core) | Report/export limits, batched scheme portfolio loads, defaulter branch recovery fix, message branch scope, streaming raw CSV export, export artifact cleanup |
| 9 | Done (core) | `ops-metrics` + queue health on readiness, env lag thresholds, wired FCM/message/broadcast/PhonePe/reminder/export metrics, `npm run ops:inspect`, [OPERATIONS_OBSERVABILITY.md](./OPERATIONS_OBSERVABILITY.md) |
| 10 | Done (gate) | Test teardown fix, `npm run test:hardening`, `npm run load:hardening`, index `--dry-run`, final report below |

### Phase 5 follow-ups (not blocking deploy)

- **5C:** `finalizeGatewaySuccess` is idempotent by `providerTransactionId` but not yet a single Mongo transaction; add fault-injection tests when reconciliation path lands.
- **5D:** Legacy plaintext PhonePe secrets still dual-read via `unsealOrRaw`; run an encrypt-in-place migration before removing plaintext acceptance.
- **5D:** Per-tenant PhonePe circuit breaker/bulkhead — deferred to Phase 6+ load work.

---

## Required MongoDB index rollout

Indexes added in Phases 2–7 (messages, push broadcast, outbox, webhooks). **Phase 5:** `WebhookEvent` unique `{ tenantId, provider, providerEventId }`. **Phase 7:** `WebhookEvent.purgeAt` TTL; `{ status, leaseExpiresAt }` for reclaim scans.

Planned operator command after index definitions land:

```bash
npm run db:sync-indexes
```

Review `sync-indexes.js` diff before production. No destructive drops in this program without explicit operator approval.

---

## Required credential rotation

After any archive or repo leak that included `.env` or tenant `integrationSecrets`:

1. JWT access + refresh signing secrets  
2. `INTEGRATION_ENCRYPTION_KEY` (re-seal or re-enter PhonePe/WhatsApp secrets)  
3. FCM service account (Firebase console → new key → update env)  
4. PhonePe client credentials per tenant  
5. WhatsApp Cloud API tokens  
6. S3 access keys  
7. Platform seed / demo passwords if exposed  

---

## Deployment order (target production)

1. Apply MongoDB indexes (non-blocking createIndex)  
2. Deploy API with new env validation (Phase 1+)  
3. Deploy workers + scheduler (same image, `worker` + `scheduler` entrypoints)  
4. Enable Redis (`REDIS_REQUIRED=true`)  
5. Switch `PROVIDER_MODE=live` and provider credentials  
6. Smoke: readiness, login, one payment sandbox, one push mock/live  

---

## Rollback considerations

- Keep previous API/worker image tag; roll back deployment if readiness fails.  
- Env validation changes (Phase 1) may **prevent startup** with old config — keep last-known-good env snapshot in secure store.  
- Index additions are backward compatible; do not drop indexes on rollback.  
- Idempotency keys in Mongo/Redis survive rollback; avoid duplicate webhooks during cutover.

---

## Load / failure-test commands

```bash
# Baseline quality gate
npm run check
npm test

# Readiness (after Phase 1)
curl -sS "$PUBLIC_BASE_URL/api/v1/health/ready" | jq .

# Push broadcast fan-out (requires worker + Redis)
# POST /api/v1/admin/push/broadcasts with MESSAGE_SEND role

# Reminder scheduler (hourly + worker)
# Confirm maintenance queue `payment-reminders` and `push-broadcast-fanout`
```

---

## Unresolved decisions

1. Whether source zip `.env` was shared externally → drives rotation scope.  
2. FCM architecture: HTTP v1 per-device vs topic (prompt Phase 3).  
3. Commit order: feature FCM branch vs hardening branch merge strategy.

## Phase 10 — validation gate (2026-09-18)

### Root cause: “stuck forever” on `npm test`

Integration tests using `createApp()` + idempotency left **ref’d timers** (rate-limit `MemoryStore` intervals and idempotency lease heartbeats). The runner then sat for ~15–18 minutes until timeout, and **every later test file was marked failed** without running.

**Fix:** `stopTestDb()` now clears idempotency heartbeats, rate-limit intervals, and Redis test connections (with bounded Mongo/replica shutdown timeouts).

### Commands (use these in CI / pre-deploy)

| Command | Purpose |
|---------|---------|
| `npm run check` | Syntax, routes, ESLint |
| `npm run test:hardening` | 65 focused tests (~25s) — **recommended gate** |
| `npm test` | Full 52-file suite (~5–6 min after teardown fix) |
| `npm run load:hardening` | Synthetic 15k dedupe / broadcast chunk / fairness (+ optional live queue snapshot) |
| `npm run db:sync-indexes:dry-run` | JSON diff (`toCreate` / `toDrop`) before apply |

**Receipt numbers (gateway success):** `nextReceipt()` allocates via `nextSequence(..., session)` inside the payment Mongo transaction. Committed payments get sequential receipt numbers; aborted transactions roll back the counter increment (gaps are possible only when a transaction aborts after sequence allocation — not gapless across failed attempts).
| `npm run ops:inspect` | Production backlog / DLQ snapshot |

### Remaining blockers (honest)

- **Production load proof:** `load:hardening` is synthetic; end-to-end 15k broadcast + workers + PhonePe traffic still needs a seeded staging run and Mongo profiler.
- **Failure-injection matrix** from the prompt (broadcast crash at every boundary, full PhonePe race catalog) — partially covered by existing unit/integration tests, not exhaustive.
- **Mongo transaction** for `finalizeGatewaySuccess` (Phase 5 follow-up).

---

## Phase acceptance log

| Phase | Date | Verified by | Notes |
|-------|------|-------------|-------|
| 0 | 2026-09-18 | Baseline + inventory | Full `npm test` completed with pending-promise file failures |
| 1 | 2026-09-18 | Env + readiness + boot checks | Targeted Phase 1 tests (see below) |
| 2 | 2026-09-18 | FCM + device registry | `fcm-outcomes`, `fcm-config-isolation`, `push-provider`, Phase 1 env tests |
| 3 | 2026-09-18 | Broadcast + dispatcher | `broadcast-fanout`, fair dispatch unit tests |
| 4 | 2026-09-18 | Reminder scheduler | `reminder-scheduler`, `reminder-config` tests |
| D | 2026-09-19 | FCM Redis limiter + 15k fan-out | `phase-d-fcm-redis`, `load:fcm-15k-mock`; automated scope only |

### Phase D — FCM delivery + Redis rate limiting (automated scope)

- **Distributed limiter:** `src/lib/fcm-redis-limiter.js` — single Lua script for global + per-tenant hash-tagged keys (`fcm:{limiter}:global`, `fcm:{limiter}:tenant:*`), TTL on keys, deny (never bypass) when Redis unavailable; workers defer via `FcmSendDeferredError` + BullMQ `DelayedError`.
- **PushDeviceDelivery index rollout:** new unique index `{ tenantId: 1, messageId: 1, deviceRegistrationId: 1 }` (Mongo default name `tenantId_1_messageId_1_deviceRegistrationId_1`). Legacy unique index `{ messageId: 1, deviceRegistrationId: 1 }` (default name `messageId_1_deviceRegistrationId_1`) may still exist until operator-confirmed drop. Safe apply: `npm run db:sync-indexes:dry-run` then `npm run db:sync-indexes` (creates new index without auto-dropping old). To drop legacy after verification: `node scripts/sync-indexes.js --apply-drops --operator-confirm-drops --confirm-drop messageId_1_deviceRegistrationId_1` — never in automated tests or deploy scripts.
- **15k fan-out:** `fetchAudienceCustomerPage` uses `$lookup` + keyset cursor (no `distinct` + `$in` materialization).
- **Batch cap:** `FCM_MULTICAST_BATCH_SIZE` (max 500) for send chunks; FCM HTTP v1 remains one request per token (at-least-once push boundary).
- **Env:** see `.env.example` `FCM_RATE_LIMIT_*` and `FCM_MULTICAST_BATCH_SIZE`.
- **Mock load:** `npm run load:fcm-15k-mock` — not a production SLO sign-off.
- **Real staging gate:** Mongo replica set + Redis + workers + `scripts/fcm-staging-15k.js --dry-run=false` + FCM test devices + `npm run ops:inspect`.
- **Broadcast fan-out recovery:** maintenance scheduler job `push-broadcast-recover` runs every **60s** and re-enqueues deterministic continuation jobs for active broadcasts with no/expired lease or pending continuation flag.
