# Ecommerce API contract addendum (ecommerce branch)

Base prefix: `/api/v1`. Money in **paise**. See [API_CONTRACT.md](./API_CONTRACT.md) for envelope conventions.

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

## Admin workspace (orders, KPIs, reports)

See **[ECOMMERCE_ADMIN_WORKSPACE_CONTRACT.md](./ECOMMERCE_ADMIN_WORKSPACE_CONTRACT.md)** for:

- Cursor-paginated `GET /admin/ecommerce/orders` (`meta.nextCursor`, `meta.totalCount`, filters, `customerDisplay`)
- `GET /admin/ecommerce/summary` (placement vs collections metrics, IST periods)
- `GET /admin/ecommerce/orders/:orderId/returns` and `returnSummary` on order detail
- `GET|POST /admin/ecommerce/reports/:reportKey` (+ CSV export via `report.export`)

## Index / migration notes

- `ecommerce_return_replacement_order_unique` — partial unique on `replacementOrderId`
- Return refund: `EcommercePaymentExceptionRefund.returnRequestId`, `refundSource: ORDER_RETURN`
- Cancellation idempotency: see [ECOMMERCE_CANCELLATION.md](./ECOMMERCE_CANCELLATION.md)
- Admin order list: `{ tenantId: 1, createdAt: -1, _id: -1 }` on `EcommerceOrder`
