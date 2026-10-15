# Ecommerce product/category FCM promotions

Marketing pushes reuse the existing **PushBroadcast** fan-out, **Message** dispatch worker, FCM provider, and customer inbox (`GET /app/notifications`).

## Admin API

| Method | Path | Permission |
|--------|------|------------|
| POST | `/admin/ecommerce/products/:productId/notifications/preview` | `ecommerce.read` |
| POST | `/admin/ecommerce/products/:productId/notifications` | `ecommerce.write` + `message.send` |
| POST | `/admin/ecommerce/categories/:categoryId/notifications/preview` | `ecommerce.read` |
| POST | `/admin/ecommerce/categories/:categoryId/notifications` | `ecommerce.write` + `message.send` |
| GET | `/admin/ecommerce/notifications` | `ecommerce.read` |
| GET | `/admin/ecommerce/notifications/:campaignId` | `ecommerce.read` |

**Publish with optional new-arrival push** — `POST /admin/ecommerce/products/:productId/publish`:

```json
{
  "expectedVersion": 3,
  "notification": {
    "enabled": true,
    "kind": "NEW_ARRIVAL",
    "title": "Optional override",
    "body": "Optional override",
    "audience": "ALL_DEVICES"
  }
}
```

Response includes `promotion: { intentPersisted, enqueued, enqueueError?, queued, duplicate?, scheduled?, reason?, campaign? }` separate from product save. A committed product save stays **200** even when immediate BullMQ enqueue fails; maintenance recovers durable `QUEUED` campaigns.

**Version conflicts** — failed patch/publish with `409 VERSION_CONFLICT` includes `error.details.current: { id, version, updatedAt }` for portal reload.

**Offer opt-in on patch** — `PATCH /admin/ecommerce/products/:productId` with `notification: { enabled: true, kind: "OFFER", ... }` only queues when offer/pricing revision changes.

## Deep links (generated server-side)

- Product: `/shop/{slug}`
- Category: `/shop?categoryId={id}`

FCM `data` includes string fields: `messageType`, `deepLink`, `productId`, `categoryId`, `promotionKind`, `campaignBusinessKey`.

## Idempotency

- Manual send: `X-Idempotency-Key` → stable `businessKey`
- New arrival: `new-arrival:{productId}` (one campaign row)
- Offer: `offer:{productId}:{offerRevision}`

Inbox dedupe: `templateParams.inboxEventKey` = `{campaignBusinessKey}:{customerId}`; legacy manual pushes fall back to `broadcastId`.

## Delivery semantics

- Eligible audience = customers with active device registration (preview label: **eligible customers**, not guaranteed delivery).
- Another in-flight tenant broadcast **queues** ecommerce promotion fan-out (`fanoutContinuationPending`).
- Marketing `dispatchPriority` = 10; payment/order messages remain 0.
- Rich images: product/category uploads only when FCM TTL ≤ presign lifetime; otherwise text-only send.

## Gold rate notifications (scheme + shop)

Optional `notification: { enabled: true }` on:

- `POST /admin/gold-rate` (22K scheme; IST business `effectiveDate`)
- `POST /admin/ecommerce/gold-rates` — `effectiveTiming`: `NOW` | `SCHEDULED` (mutually exclusive with `effectiveAt`; `NOW` resolves server time at publish)

Requires `message.send` when enabled. Scheme publishes enforce branch scope: branch roles must send their own `branchId`; tenant-wide rates require tenant-level roles.

History: `GET /admin/gold-rate/notifications` (scheme rate campaigns; no ecommerce entitlement).

Uses the same campaign row, lease, broadcast uniqueness (`sourceKind: GOLD_RATE_NOTIFICATION`), and message reconciliation as product promotions.

Message types: `SCHEME_GOLD_RATE_UPDATED`, `ECOMMERCE_GOLD_RATE_UPDATED`. Deep links: `/gold-rate/current`, `/shop`.

FCM `data` (strings): `rateId`, `rateSource`, `purity`, `ratePerGramPaise`, `schemeEffectiveDate`, `effectiveAt`, `branchId`, plus `messageType`, `campaignBusinessKey`, `deepLink`.

Historical backfill (explicit past `effectiveAt` / scheme business date before today IST) does not create notification intent. Future rates schedule until effective. Stale prior-day scheme dailies cancel at delivery with `STALE_BUSINESS_DATE`.

## Native app

Flutter must register FCM via `POST /app/devices/fcm-token` and handle tap using `data.deepLink`. See `docs/FCM_CUSTOMER_APP_INTEGRATION.md`.

## Schema

- `EcommercePromotionCampaign` — `tenantId + businessKey` unique; delivery lease fields `deliveryLeaseOwner`, `deliveryLeaseExpiresAt`, `deliveryAttemptCount`; stats `delivered`, `failed`, `pending`; `fanoutCompletedAt`
- `EcommerceProduct.firstPublishedAt` — first publication timestamp
- `PushBroadcast` — extended `messageType`, `sourceKind`, `campaignBusinessKey`, rate metadata; **unique** `(tenantId, campaignBusinessKey)` partial filter `sourceKind ∈ { ECOMMERCE_PROMOTION, GOLD_RATE_NOTIFICATION }`

### Index rollout (required on deploy)

Existing deployments may have `tenantId_1_campaignBusinessKey_1` with the old `ECOMMERCE_PROMOTION`-only partial filter. Use the dedicated migration (coordinate to pause broadcast writes during `--apply`):

```bash
node --env-file=.env scripts/migrate-push-broadcast-campaign-key-index.js --dry-run
node --env-file=.env scripts/migrate-push-broadcast-campaign-key-index.js --apply
```

Fresh databases can use `npm run db:sync-indexes` instead. After either path:

Restart **API**, **worker**, and **scheduler** so BullMQ processors pick up `ecommerce-promotion-deliver` / `ecommerce-promotion-maintenance` (maintenance every 60s).
