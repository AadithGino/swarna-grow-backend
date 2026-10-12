# Ecommerce admin workspace API contract

Tenant-scoped admin APIs for order workspace, dashboard KPIs, and reports. Money is **integer paise**. Calendar boundaries use **Asia/Kolkata** (`from` / `to` as `YYYY-MM-DD`, or `period` presets via existing report range rules).

## Orders list — `GET /admin/ecommerce/orders`

**Permission:** `ecommerce.read`

**Pagination:** Cursor on `createdAt` + `_id`, descending. Response:

```json
{
  "success": true,
  "data": [ /* order rows */ ],
  "meta": {
    "nextCursor": "…",
    "hasMore": true,
    "limit": 20,
    "totalCount": 123,
    "totalCountCapped": false,
    "sort": "createdAt:desc"
  }
}
```

`totalCount` is a separate count for the current filter set (capped at 50 000; `totalCountCapped: true` when higher).

**Filters (stable across pages — encoded in cursor `filterHash`):**

| Query | Meaning |
|-------|---------|
| `q` | Order number, customer id, or order id |
| `status` | Exact order status enum |
| `paymentMethod` | `ONLINE` \| `COD` |
| `fulfilmentMode` | Fulfilment mode enum |
| `createdFrom` / `createdTo` | Placed-at range |
| `paymentException=true` | Open payment exception flag on order |
| `codPendingAcceptance=true` | Status `COD_PENDING_ACCEPTANCE` |
| `cancellationPending=true` | `activeCancellationRequestId` set |
| `returnPending=true` | Active return request for order |
| `collected=true` \| `false` | **Collected** = online with `paidAt` **or** COD with `codCollection.status=COLLECTED` (not inferred from status label alone) |

**Customer display:** Each row may include `customerDisplay: { customerId, name, maskedMobile, customerNumber }` from tenant-scoped `Customer` lookup, falling back to checkout `addressSnapshot` (never cross-tenant).

## Order detail — `GET /admin/ecommerce/orders/:orderId`

Includes `returnSummary: { activeRequest, recent[] }` (order-scoped; no global return list scan).

## Order returns — `GET /admin/ecommerce/orders/:orderId/returns`

**Permission:** `ecommerce.read`

Returns `{ orderId, activeRequest, items[] }` for that order only.

## Workspace summary — `GET /admin/ecommerce/summary`

**Permissions:** `ecommerce.read` + `report.read`

**Query:** `from`, `to`, and/or `period` (same as other admin reports).

**Response:** `period`, `generatedAt`, `placement`, `pipeline`, `collections`.

### Metric definitions

**Placement (order placed in period — `createdAt` in range):**

- `ordersPlaced` — all orders created in period.
- `onlinePaidOrdersPlacedInPeriod` — online method with non-null `paidAt` (still “placed” metric, not cash-flow).
- `codPendingAcceptancePlacedInPeriod` — status `COD_PENDING_ACCEPTANCE` placed in period.

**Pipeline (current snapshot, not period-bound):**

- `awaitingFulfilment` — status `PAID` or `PROCESSING`.
- `readyForPickup`, `shipped`, `delivered` — exact status counts.
- `openCancellationRequests` — cancellation request status pending decision or approved processing.
- `openReturnRequests` — return status pending review through inspected.
- `paymentExceptionsOpen` — orders with non-null `paymentExceptionStatus`.

**Collections (cash-flow in period — separate from placement):**

- `onlineCollectedPaise` — online orders with `paidAt` in period (`totalPaise`).
- `codCollectedPaise` — COD with `codCollection.status=COLLECTED` and `codCollection.collectedAt` in period (amount from `codCollection.amountPaise` or order total).
- **Not revenue:** pending online payment; COD placed/accepted without recorded collection.
- `providerRefundOutflowPaise` — `EcommercePaymentExceptionRefund` with status `SUCCEEDED` and status-set timestamp (`updatedAt`) in period.
- `manualRefundOutflowPaise` — exception refunds `MANUAL_RECORDED` (timestamp `updatedAt`) **plus** COD cancellation manual refunds (`codManualRefund.recordedAt`) **plus** return manual refunds (`manualRefundRecordedAt`). Each counted once at its recorded time; the related order may have been placed earlier.
- `refundOutflowPaise` — sum of provider + manual outflows (refund may relate to an order placed outside the period).
- `netCollectedPaise` — gross collected minus refund outflow (integer paise).
- `averageCollectedOrderValuePaise` — gross collected ÷ count of collected orders in period (online paid + COD collected events).

No profit/margin (no COGS). Scheme collections, gold rates, and scheme refunds are **excluded**.

## Reports — `GET /admin/ecommerce/reports/:reportKey`

**Permissions:** `ecommerce.read` + `report.read`

| reportKey | Purpose |
|-----------|---------|
| `ECOMMERCE_SALES` | Collections, tax, fulfilment charges, refunds, net (definitions match summary collections). |
| `ECOMMERCE_ORDERS_FULFILMENT` | Orders **placed** in period by status. |
| `ECOMMERCE_PRODUCTS` | Units and **collected** line totals from line snapshots on collected orders in period. |

Pagination via report `meta` / `cursor`. CSV export: `POST /admin/ecommerce/reports/:reportKey/export` with `ecommerce.read` + `report.export`; uses async export pipeline with `_exportAll` for full filtered rows.

## Entitlement

Historical reads remain available with `ecommerce.read` when the store switch is off; write/management gates unchanged. Customer storefront availability is separate.
