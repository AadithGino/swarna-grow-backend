# Ecommerce order cancellation (V1)

## Customer

| Action | When |
|--------|------|
| **Direct cancel** | `PENDING_PAYMENT` (no in-flight/uncertain payment attempt), `COD_PENDING_ACCEPTANCE` — releases reservations once |
| **Request cancellation** | `PAID`, `PROCESSING`, `READY_FOR_PICKUP` — order stays active until staff decide |
| **Contact store** | `SHIPPED`, `DELIVERED` — no API cancellation |

Order list/detail work when the storefront is disabled (`assertEcommerceOperational` not required for read/cancel request).

## Admin

- **Approve / reject** pending requests (`expectedVersion`, optional `stockDisposition` when stock was consumed).
- **Initiate cancellation** with reason (creates request + auto-approve flow).
- **COD manual refund** after approval when cash was collected (`ECOMMERCE_REFUND_OPERATE`).

Fulfilment transition to `CANCELLED` is blocked — use cancellation endpoints.

## Refunds

- **Online paid:** approval → `REFUND_PENDING` + ASSIGNED PhonePe refund case (`refundSource=ORDER_CANCELLATION`). **Fulfilment approve does not call PhonePe** — staff with `ECOMMERCE_REFUND_OPERATE` must `POST .../payment-exception-refund/initiate`. Manual bank refund via `record-manual` completes the linked cancellation request.
- **COD, not collected:** cancel after stock disposition.
- **COD, collected:** manual refund record required before order `CANCELLED`.

## API (summary)

**Customer**

- `POST /app/shop/orders/:orderId/cancel`
- `POST /app/shop/orders/:orderId/cancellation-requests`
- `GET /app/shop/orders/:orderId/cancellation`

**Admin**

- `GET /admin/ecommerce/cancellation-requests`
- `GET /admin/ecommerce/orders/:orderId/cancellation`
- `POST /admin/ecommerce/orders/:orderId/cancellation/decision`
- `POST /admin/ecommerce/orders/:orderId/cancellation/initiate`
- `POST /admin/ecommerce/orders/:orderId/cancellation/cod-manual-refund`

## Stock disposition evidence

Paid and COD-accepted orders record `stockConsumptionEvidence[]` at the same transaction as inventory deduction (including `quantityDeducted: 0` for made-to-order lines). Cancellation restock and disposition checks use this evidence, not the SKU’s current `stockPolicy`. Legacy orders without evidence may infer from adjustments or released reservations when `stockConsumedAt` is set; otherwise staff must use `STOCK_EXCEPTION` or resolve inventory before `RESTOCK_CONFIRMED`.

## Cancellation request idempotency index

Unique scope is `{ tenantId, idempotencyKey }` (partial: non-empty key). Before rollout in an existing database, run `node --env-file=.env scripts/detect-cancellation-idempotency-conflicts.js`. Resolve any reported duplicates, then use `scripts/sync-indexes.js --dry-run` / `--apply` and explicitly confirm-drop the old per-order compound idempotency index if present.

## Operational policy decisions (remaining)

1. **Partial refunds** — V1 is full order total only.
2. **Customer withdraw** of pending request — enum exists (`WITHDRAWN`) but no endpoint yet.
3. **Auto-reject** requests when order moves to `SHIPPED` while pending — currently staff must reject manually.
4. **Notification copy** — outbox `ORDER_UPDATED` enqueued; customer push templates not wired.
5. **Post-`REFUNDED` vs `CANCELLED` label** for online orders — provider success sets `REFUNDED`; consider also marking `CANCELLED` for reporting if ops require both flags.
