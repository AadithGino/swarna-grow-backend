# Ecommerce cash on delivery (COD)

Third-party **courier COD**: the courier collects at delivery and later remits to the jeweller’s bank. SwarnaGrow staff do not record cash-in-hand or staff custody for courier COD.

## Configuration

- `codEnabled` and `codPincodes` on fulfilment settings (subset of serviceable pincodes).
- COD is **delivery-only**.

## Lifecycle

1. Place order → `COD_PENDING_ACCEPTANCE`, `courierCod.collectionStatus=PENDING`.
2. Staff accept → `PROCESSING`.
3. Fulfilment → delivery proof separate from courier collection.
4. **Courier collection confirmed** — `POST …/courier-cod/confirm-collection` (manual evidence until integration exists).
5. **Remittance batch** — statement lines and bank reconcile (`…/courier-cod/remittance-batches/*`).

Delivery does **not** imply collection; collection does **not** imply bank receipt.

## Reporting (date basis)

| Series | Date field | In net collections with online? |
|--------|------------|----------------------------------|
| Online | `paidAt` | Yes |
| Courier collection confirmed | `courierCod.collectionConfirmedAt` | No (operational KPI) |
| Bank remittance net | `courierCod.bankCreditedAt`, `BANK_RECONCILED` | Yes |

## Development / test database reset

Staff COD was never deployed. To reset prototype COD data in a **known dev/test** database only:

```javascript
// Example — run manually in mongosh against dev/test, NOT production
db.ecommercecodremittancelines.deleteMany({});
db.ecommercecodremittancebatches.deleteMany({});
db.ecommerceorders.updateMany(
  { paymentMethod: "COD" },
  {
    $unset: {
      codCollection: "",
      codCustody: "",
    },
    $set: {
      "courierCod.collectionStatus": "PENDING",
      "courierCod.remittanceStatus": "NOT_DUE",
    },
  },
);
```

Do not run destructive cleanup against an unknown or production database.

## Out of scope (deferred P0)

- Branch-wide ecommerce authorization.
- Branch-specific pickup stock.
- Live courier integration (manual V1 workflow).
- PhonePe ecommerce production rollout.
