# Advance booking — payment ownership and refund schema (first diff)

Booking payment entry points stay **disabled**. Nothing in this diff creates a booking attempt,
a booking refund, or a converted order. It prepares payments and refunds to be owned by a booking
and for one order to be paid by two captures.

## What changed

| Area | Change |
|---|---|
| Payment ownership | `EcommercePaymentAttempt`, `EcommercePaymentAttemptEvent`, `EcommercePaymentExceptionRefund` gain `bookingId` and `purpose` (`ORDER_CHECKOUT`, `BOOKING_ADVANCE`, `BOOKING_BALANCE`). `orderId` is optional, but a row must have an `orderId` or a `bookingId`. Rows with no `purpose` are ordinary checkout (`resolvePaymentPurpose`, `ORDER_CHECKOUT_PURPOSE_FILTER`). |
| Active-attempt indexes | `tenantId_1_orderId_1` is replaced by `ecommerce_attempt_active_order_unique` (same key, only attempts with an `orderId`). New `ecommerce_attempt_active_booking_purpose_unique` on `(tenantId, bookingId, purpose)`. An active booking attempt cannot carry an `orderId`. |
| Order allocations | `EcommerceOrder.paymentAllocations[]` (`paymentAttemptId`, `purpose`, `appliedPaise`): unique by capture, must sum to `totalPaise`. Older orders resolve one allocation from `successfulPaymentAttemptId` (`resolveOrderPaymentAllocations`). `successfulPaymentAttemptId` names one capture only and is never the total paid. |
| Refund identity | `refundOperationId` on refund rows, unique on `(tenantId, refundOperationId, paymentAttemptId)`. Operation ids: `return:<id>`, `cancel:<id>`, `exception:<attemptId>`, and (booking phase) `booking-expiry:<bookingId>`, `excess:<bookingId>`. Replaces `ecommerce_capture_refund_without_return_unique` and `ecommerce_return_refund_unique`. |
| Refund capacity | `lib/ecommerce-refund-allocator.js`. `ASSIGNED`, `INITIATED`, `PROVIDER_PENDING`, `SUCCEEDED`, `MANUAL_RECORDED` hold capacity; only a confirmed `FAILED` frees it. Balance first, then advance. Each capture is locked by bumping `refundCapacityLockSeq` inside the transaction so concurrent refunds conflict and retry. Retrying a `FAILED` row reuses it and re-reserves capacity. |
| Return / cancellation | Open one refund row per capture. `onlineRefundIds[]` records them (`onlineRefundId` stays the first). A return resolves, and a cancellation completes, only when every row has settled. |
| Guards | The order reconcile scan and claim skip booking-owned attempts. The order finalizer returns `BOOKING_PAYMENT_NOT_ENABLED` for a booking capture. The refund webhook alerts and skips an order-less booking refund. |

## Deploy order (production has `autoIndex` off and refuses to start on an unmigrated database)

1. Stop API and workers (writes paused).
2. `node scripts/migrate-financial-invariants.js` — dry run; review `duplicates`, `legacyIndexes`, `unbackfilled`.
3. `node scripts/migrate-financial-invariants.js --apply --writes-paused`. This backfills `refundOperationId`, re-checks for duplicates, creates the three replacement indexes, verifies they exist, and only then drops the retired ones. It is safe to run twice.
4. Deploy this code and restart. Deploying the code first fails safe (duplicate-key errors, no duplicate refunds) but is not supported.

## Not in this diff (next phases)

Booking models and services, the booking finalizer and reconciler, booking-owned stock reservations
and the third reservation owner, saved-rate pricing, order conversion, booking refund webhooks
(order-less refunds), and customer or admin screens.
