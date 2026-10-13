# Ecommerce integration gaps — implementation report

Date: 2026-10-12

## Summary

This iteration adds customer-scoped admin order history, cursor-paginated customer order lists, COD custody tracking (separate from scheme cash), fulfilment handover evidence, order-linked grievances, and historical admin visibility after plan downgrade via `hasOrderHistory`.

## API additions

| Method | Path | Permission |
|--------|------|------------|
| GET | `/admin/customers/:customerId/ecommerce/orders/meta` | `ecommerce.read` |
| GET | `/admin/customers/:customerId/ecommerce/orders` | `ecommerce.read` |
| GET | `/app/shop/orders` | cursor query (`limit`, `cursor`) |
| POST | `/app/shop/orders/:orderId/confirm-pickup` | customer |
| GET | `/admin/ecommerce/courier-cod/summary` | `ecommerce.read` |
| POST | `/admin/ecommerce/orders/:orderId/courier-cod/confirm-collection` | `ecommerce.fulfilment.operate` |
| POST/GET | `/admin/ecommerce/courier-cod/remittance-batches/*` | read / fulfilment operate |
| POST | `/admin/ecommerce/orders/:orderId/pickup-code` | `ecommerce.fulfilment.operate` |
| POST | `/admin/ecommerce/orders/:orderId/delivery-handover` | `ecommerce.fulfilment.operate` |

**Contract fields**

- `ecommerce.hasOrderHistory` on admin subscription, operations, store-status, and customer shop availability.
- Grievance `relatedEntity.type`: `ORDER` (validated against customer + tenant).

## Courier COD data model

- `courierCod` on orders; remittance batches/lines collections with tenant-scoped indexes (including unique bank credit reference per provider when reconciled).
- No staff cash custody or `codCollection` fields — courier manual evidence + bank reconcile only.

## Unresolved P0 (explicitly out of scope)

1. **Branch-wide ecommerce authorization** — admin ecommerce routes remain tenant-wide; branch-scoped staff may see orders outside their branch assignment.
2. **Tenant-wide stock for pickup** — inventory/reservations are not branch-partitioned; branch KPIs/queues were not added (would mislead on current data).

## Product decisions (fail-closed)

- **Delivery proof** cannot be set via courier tracking patch; `deliveredAt` on tracking is no longer user-settable.
- **Mark DELIVERED** requires recorded handover evidence (pickup code or delivery proof).

## Tests

Run focused suite:

```bash
cd swarnagrow-backend
npm run check
npm run test -- tests/ecommerce-integration-gaps.test.js
```

Frontend:

```bash
cd SwarnaGrow-Tenant-Admin
npm run typecheck && npm run lint && npm run test && npm run build
```

Full backend `npm test` (~1h): **pending release gate** (not run in this iteration).

## Not production-ready statement

Ecommerce operations remain **not production-ready** while the two P0 items above are open. This release improves history, custody audit trails, and support linkage but does not fix branch auth or branch inventory.
