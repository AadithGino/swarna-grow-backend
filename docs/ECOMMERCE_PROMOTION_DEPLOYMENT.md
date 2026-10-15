# Ecommerce promotion & FCM — production deployment

Production sets `autoIndex: false` on Mongoose (`src/config/database.js`). **Indexes are not created automatically** when API/worker processes start. Plan an explicit index rollout before or with each promotion-pipeline release.

## 1. Index rollout (read-only preview, then explicit apply)

From the backend repo root, with production `MONGODB_URI` in `.env`:

```bash
# Preview only — diffIndexes(), no syncIndexes / createIndexes / drops
node --env-file=.env scripts/sync-ecommerce-promotion-indexes.js
# or
node --env-file=.env scripts/sync-ecommerce-promotion-indexes.js --dry-run

# Apply promotion + broadcast indexes (mutates indexes)
node --env-file=.env scripts/sync-ecommerce-promotion-indexes.js --apply
```

Do **not** pass `--dry-run` and `--apply` together.

Preview output lists indexes **to create** and **to drop** per model. Apply runs `syncIndexes()` only when `--apply` is set.

### Campaign business key migration (ordering)

When upgrading gold-rate fanout uniqueness, run this **before or alongside** the promotion index sync (duplicate check + controlled unique-index upgrade):

```bash
node --env-file=.env scripts/migrate-push-broadcast-campaign-key-index.js --dry-run
node --env-file=.env scripts/migrate-push-broadcast-campaign-key-index.js --apply
```

Recommended order:

1. `migrate-push-broadcast-campaign-key-index.js --dry-run` (resolve duplicates if reported).
2. `sync-ecommerce-promotion-indexes.js` (preview).
3. `migrate-push-broadcast-campaign-key-index.js --apply` (if legacy partial index still present).
4. `sync-ecommerce-promotion-indexes.js --apply`.

Indexes touched include at least:

- `EcommercePromotionCampaign`: `{ dispatchReconciledAt: 1, status: 1, updatedAt: 1 }` (partial, `broadcastId` present)
- `PushBroadcast`: `{ status: 1, fanoutResumeAt: 1, updatedAt: 1 }`, `{ status: 1, completedAt: 1, campaignBusinessKey: 1 }`, `{ status: 1, fanoutStopRecoveryCompletedAt: 1, completedAt: 1 }` (partial, `fanoutStopReason` present), plus fanout/lease indexes

Do not run index migrations during heavy broadcast writes without coordination.

### Stop-recovery backfill (no one-off script)

Historical stopped broadcasts (`fanoutStopReason` on `COMPLETED`) without `fanoutStopRecoveryCompletedAt` are **backfilled on the next maintenance pass** once the linked campaign is no longer `QUEUED`/`SENDING`. New interrupted stops use the marker so recovery scans stay bounded.

## 2. Process restarts (required)

Code changes affect **API**, **worker**, and **scheduler** (maintenance repeatable jobs). Running workers **do not** pick up new fanout/stop/reconciliation logic until restarted.

Recommended order:

1. Preview indexes; apply migrations/indexes as above.
2. Deploy backend artifact.
3. Restart **worker** (`npm run worker` or your process manager equivalent).
4. Restart **scheduler** once (`npm run scheduler`) so repeatable maintenance jobs re-register.
5. Restart **API** (`npm run dev:api` / production API tier).

Redis must be available for delayed NOT_DUE fanout continuations; if enqueue fails after deferral is persisted, `push-broadcast-recover` maintenance re-enqueues using `fanoutResumeAt` and the `-fanout-due-*` job id.

## 3. Operational notes

- Stopped campaigns (`CANCELLED` + `fanoutStopReason` on broadcast) continue **dispatch reconciliation** until `dispatchReconciledAt` is set (independent of `fanoutStopRecoveryCompletedAt`).
- `delivered` stats reflect FCM acceptance (`SENT`/`DELIVERED`/`READ`), not confirmed device delivery.
- See `docs/ECOMMERCE_PROMOTION_FCM.md` for product behaviour and `docs/ECOMMERCE_API_CONTRACT.md` for PATCH/schedule semantics.
