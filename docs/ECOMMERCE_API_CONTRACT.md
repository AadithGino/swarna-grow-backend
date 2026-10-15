# Ecommerce API contract addendum (ecommerce branch)

Base prefix: `/api/v1`. Money in **paise**. See [API_CONTRACT.md](./API_CONTRACT.md) for envelope conventions.

**Flutter / customer app:** end-to-end shop flows with example payloads → [ECOMMERCE_CUSTOMER_APP_GUIDE.md](./ECOMMERCE_CUSTOMER_APP_GUIDE.md).

## Customer shop (`CUSTOMER` → `/app/shop/*`)

### `GET /app/shop/store-policies`

Published store policies for disclosure (shipping, returns, cancellation, refund contact). Checkout remains blocked server-side until all four policies are approved in fulfilment settings.

**Response `data`:**

```json
{
  "published": true,
  "policies": {
    "version": 2,
    "publishedAt": "ISO",
    "shippingPolicyText": "string",
    "returnsPolicyText": "string",
    "cancellationPolicyText": "string",
    "refundContactPolicyText": "string",
    "returnEligibilityDays": 7
  }
}
```

When not ready: `{ "published": false, "policies": null }`.

### `GET /app/shop/products`

**Query:** `categoryId`, `cursor`, `limit`, `featured=true`, `q` (≥2 chars, name search), `sort=newest|name` (no price sort — dynamic gold pricing).

### `GET /app/shop/orders/:orderId/return`

Latest return/exchange request for the authenticated customer on that order.

### `POST /app/shop/orders/:orderId/return-requests`

**Body:** `{ "reason": "string (≥8)", "kind": "RETURN|EXCHANGE?", "evidenceNote": "string?" }`  
**Headers:** `X-Idempotency-Key`

## Admin fulfilment & returns (`TENANT_USER`, permissions as noted)

### `PATCH /admin/ecommerce/orders/:orderId/delivery-tracking`

**Permission:** `ECOMMERCE_FULFILMENT_OPERATE`  
**Body:** `expectedVersion`, optional `carrierName`, `trackingNumber`, `trackingUrl` (https), `dispatchedAt`, `deliveredAt`  
Delivery orders only. Pickup orders → `422 NOT_DELIVERY_ORDER`.

### `GET /admin/ecommerce/return-requests`

**Permission:** `ECOMMERCE_READ` — list recent return requests (tenant-scoped).

### Return workflow

| Step | Route | Permission | Notes |
|------|--------|------------|--------|
| Approve/reject | `POST .../return-requests/:id/decision` | Fulfilment | |
| Parcel received | `POST .../return-requests/:id/received` | Fulfilment | **Does not restock** |
| Inspection | `POST .../return-requests/:id/inspection` | Fulfilment | `inspectionOutcome`: `APPROVED_FOR_RESALE` requires `confirmRestockInventory: true` for **one-time** restock from consumption evidence; `REJECTED_NOT_RESALABLE` never restocks |
| Resolve | `POST .../return-requests/:id/resolve` | Fulfilment | `replacementOrderId` must match same tenant/customer; unique link index |
| Online refund case | `POST .../return-requests/:id/refund-case` | Refund operate | Creates `ORDER_RETURN` payment exception refund row; does not initiate PhonePe |
| Manual refund proof | `POST .../return-requests/:id/record-manual-refund` | Refund operate | COD / manual only; idempotent |

## Outbox topics (worker)

- `ecommerce.payment.succeeded|failed|expired`
- `ecommerce.refund.completed`
- `ecommerce.fulfilment.milestone`
- `ecommerce.order.updated` (COD, cancellation)

Dead-letter replay: `node scripts/reconcile-ecommerce-outbox-dead-letter.js` (dry-run first).

## Courier COD (manual operator; no live courier integration)

**Permission:** `ECOMMERCE_FULFILMENT_OPERATE` for writes; `ECOMMERCE_READ` for summary and batch reads.

| Method | Route | Body / notes |
|--------|--------|----------------|
| POST | `/admin/ecommerce/orders/:orderId/courier-cod/confirm-collection` | `expectedVersion`, `reference`, optional `evidenceNote`, `providerId` — idempotent via `X-Idempotency-Key` |
| GET | `/admin/ecommerce/courier-cod/summary` | Workspace counts (pending collection, owed, batches) |
| GET | `/admin/ecommerce/courier-cod/remittance-batches` | List batches |
| GET | `/admin/ecommerce/courier-cod/remittance-batches/:batchId` | Batch + lines |
| POST | `/admin/ecommerce/courier-cod/remittance-batches` | `{ statementReference }` — create draft batch |
| POST | `/admin/ecommerce/courier-cod/remittance-batches/:batchId/orders/:orderId/lines` | `{ grossPaise, feePaise }` — gross must match order COD total |
| POST | `/admin/ecommerce/courier-cod/remittance-batches/:batchId/reconcile` | `{ bankCreditReference, bankCreditPaise, bankCreditedAt? }` — idempotent reconcile |

**Removed (do not call):** `/admin/ecommerce/cod-custody/*`, `/admin/ecommerce/orders/:orderId/cod/record-collection`.

See [ECOMMERCE_COD.md](./ECOMMERCE_COD.md) for lifecycle, migration, and reporting date basis.

## Admin workspace (orders, KPIs, reports)

See **[ECOMMERCE_ADMIN_WORKSPACE_CONTRACT.md](./ECOMMERCE_ADMIN_WORKSPACE_CONTRACT.md)** for:

- Cursor-paginated `GET /admin/ecommerce/orders` (`meta.nextCursor`, `meta.totalCount`, filters, `customerDisplay`)
- `GET /admin/ecommerce/summary` (placement vs collections metrics, IST periods)
- `GET /admin/ecommerce/orders/:orderId/returns` and `returnSummary` on order detail
- `GET|POST /admin/ecommerce/reports/:reportKey` (+ CSV export via `report.export`)

## Promotional banners (catalog)

**Permissions:** `ECOMMERCE_READ` list/get; `ECOMMERCE_WRITE` create/patch/publish/unpublish/archive. Writes require plan `ecommerce` entitlement (`assertEcommerceCatalogWrite`); reads remain available after downgrade (historical banners).

| Method | Route | Notes |
|--------|--------|--------|
| GET | `/admin/ecommerce/banners` | Cursor list; optional `status`, `placement` |
| POST | `/admin/ecommerce/banners` | Create **DRAFT**; idempotent create |
| GET | `/admin/ecommerce/banners/:bannerId` | |
| PATCH | `/admin/ecommerce/banners/:bannerId` | `expectedVersion` required |
| POST | `/admin/ecommerce/banners/:bannerId/publish` | Requires image + valid schedule/targets |
| POST | `/admin/ecommerce/banners/:bannerId/unpublish` | → **DRAFT** |
| POST | `/admin/ecommerce/banners/:bannerId/archive` | → **ARCHIVED** |
| POST | `/admin/ecommerce/uploads/presign` | `ECOMMERCE_WRITE`; catalog/banner upload purposes only |
| POST | `/admin/ecommerce/uploads/:uploadId/complete` | Same scope; completes presigned banner/catalog image |
| GET | `/admin/ecommerce/uploads/:uploadId` | `ECOMMERCE_READ`; catalog/banner image download (no settings permission) |

**Schedule PATCH:** omit `startsAt` / `endsAt` to leave unchanged; send JSON `null` to clear a boundary. Validation runs on the **final** window after merge. **PUBLISHED** banners cannot drop `imageUploadId` without unpublishing first.

**Customer (typed destinations only — no arbitrary URLs):**

| Method | Route | Visibility |
|--------|--------|------------|
| GET | `/app/home/banners` | Plan entitled; **HOME** + **BOTH** placements; published + in schedule. Customer UI: **Offers** horizontal rail on home (after Active schemes). |
| GET | `/app/shop/banners` | Operational store; **SHOP** + **BOTH**. Customer UI: same **Offers** rail inside the catalog grid (after two product rows); hidden while search/filters active. |

Both customer list routes return:

```json
{
  "items": [ /* visible promos only */ ],
  "meta": {
    "nextVisibilityChangeAt": "2026-01-20T04:30:00.000Z",
    "serverTime": "2026-01-01T12:00:00.000Z"
  }
}
```

`meta.nextVisibilityChangeAt` is the earliest upcoming schedule start or end among **published** banners on that surface (including promos not yet visible). An empty `items` array may still include a future boundary so clients can refresh at the right time without polling unpublished content.

Example customer item:

```json
{
  "id": "ebnr_abc",
  "title": "Festive edit",
  "subtitle": "22K highlights",
  "imageUploadId": "upload_xyz",
  "imageUrl": "/uploads/upload_xyz",
  "displayOrder": 0,
  "startsAt": "2026-01-20T04:30:00.000Z",
  "endsAt": null,
  "destination": { "type": "PRODUCT", "productId": "eprd_1", "slug": "gold-ring" }
}
```

Upload purpose: `ECOMMERCE_BANNER_IMAGE` (same size/types as catalog images). Customer download allowed only when the banner is published, in schedule, entitled for home and/or shop surface, destination targets are still valid, and **SHOP/CATEGORY/PRODUCT destinations require an operational store** (even for HOME/BOTH placement). This check runs for **every** customer banner download (store on or off). Customers must not pass `subjectId` (or any query owner) to bypass visibility. Unpublish, archive, or end-of-schedule removes customer list entries **and** blocks new `GET /app/uploads/:id` downloads for customers. Presigned image URLs already issued remain valid for up to **15 minutes** (`expiresInSeconds: 900`); list refresh does not revoke them early. **ARCHIVED** banners cannot be published, unpublished, or patched.

Demo posters: `npm run seed:ecommerce-demo -- --apply --allow-demo-data --tenants=MEHER,KAIRALI` seeds published banners (see `scripts/lib/ecommerce-demo-banners.js`).

## Admin product PATCH schedule semantics

`PATCH /admin/ecommerce/products/:productId` merges nested pricing fields field-by-field:

| Request value | Effect |
|---------------|--------|
| Field omitted | Stored value preserved (including sub-second UTC instants on schedules). |
| `null` on clearable schedule or sale fields | Clears the stored value. |
| ISO-8601 datetime string | Replaces the stored instant (validated; start must not be after end in merged state). |
| `offer: null` | Removes the entire making-charge offer (gold-rate products). |
| `priceMode` change | Replaces pricing shape for the new mode; does not deep-merge across modes. |

Promotion fanout revalidates campaign targets **before each fanout chunk** (including resume). Invalid targets stop new messages with `skippedReason` on the campaign (e.g. `PRODUCT_NOT_PUBLISHED`, `STALE_BUSINESS_DATE`, `NO_ELIGIBLE_RECIPIENTS`). Completed fanout with zero message rows terminates as `CANCELLED` + `NO_ELIGIBLE_RECIPIENTS`, not `SENT`.

Maintenance continues **dispatch reconciliation** for stopped campaigns (`dispatchReconciledAt` null) until linked `Message` rows reach terminal states, then sets `dispatchReconciledAt`. Campaign `status`/`skippedReason` stay unchanged while stats refresh.

## Index / migration notes

- `ecommerce_return_replacement_order_unique` — partial unique on `replacementOrderId`
- Return refund: `EcommercePaymentExceptionRefund.returnRequestId`, `refundSource: ORDER_RETURN`
- Cancellation idempotency: see [ECOMMERCE_CANCELLATION.md](./ECOMMERCE_CANCELLATION.md)
- Admin order list: `{ tenantId: 1, createdAt: -1, _id: -1 }` on `EcommerceOrder`
