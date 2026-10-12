# Ecommerce cash on delivery (COD)

## Configuration

- `codEnabled` (default **false**) and `codPincodes` on fulfilment settings.
- Each COD pincode must be a unique six-digit string and a **subset** of `serviceablePincodes`. Invalid admin saves are rejected (nothing is silently dropped).
- `codAcceptanceWindowMinutes` (default **120**, range 30–2880): stock stays reserved while the order is `COD_PENDING_ACCEPTANCE`.

## Customer eligibility

COD requires: operational store, ecommerce plan, checkout tax ready, delivery enabled, `codEnabled`, delivery fulfilment mode, and a **saved** address whose pincode is in `codPincodes`. Pickup never supports COD.

`paymentAllowed` remains **online-only** (PhonePe + rollout gates). COD uses `orderPlacementAllowed` / `paymentMethods[].eligible` for method `COD`.

## Lifecycle

1. Quote snapshots `paymentMethod` (`ONLINE` | `COD`, default ONLINE) and `codPincodeSnapshot`.
2. Place order: COD → `COD_PENDING_ACCEPTANCE`, `codCollection.status=PENDING`, no payment attempt.
3. Staff **accept** → `PROCESSING` + consume quantity-tracked stock once.
4. Staff **reject** or acceptance **expiry** → `CANCELLED` + release reservations once (`COD_REJECTED` / `COD_ACCEPTANCE_EXPIRED`).
5. Staff **record collection** (full amount only, idempotent) before **DELIVERED** on COD orders.
6. Online `PENDING_PAYMENT` expiry job does **not** touch COD orders.

## Cancellation after collection

V1: collected COD orders are not reversed via PhonePe. Use manual refund/accounting (`COD_MANUAL_REFUND_RECORDED` event can be added in ops runbooks); gateway refund flows apply to online payments only.
