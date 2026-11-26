# Flutter — scheme shop checkout & redemption (API contract)

Use with customer app endpoints under `/api/v1/app/…`. No separate Flutter repo in this monorepo; wire these fields in your mobile client.

## Scheme detail `GET /app/schemes/:id`

| Field | Use in UI |
|--------|-----------|
| `shopBalanceSummary.summaryLine` | One-line on home / scheme card (“₹X used online · ₹Y left for shop”) |
| `shopBalanceSummary.usedLabel` / `availableLabel` | Scheme detail “Online shop balance” panel |
| `onlineEncumbrance.summaryLines` | Bullets under passbook: reserved vs consumed vs ledger |
| `schemeSpend` | Completed shop orders (deduction rows) |
| `schemeSpendAttempts` | Include failed/expired checkouts with `outcomeLabel` |

## Passbook `GET /app/schemes/:id/passbook`

Same spend arrays plus `onlineEncumbrance`. Payment `rows` are installments only; **shop use** may appear as `REDEMPTION_DEBIT` with `metadata.source === "ONLINE_SHOP"` once order is delivered.

## Redemption `GET /app/schemes/:id/settlement-preview?mode=CASH|GOLD_HANDOVER`

| Field | Use in UI |
|--------|-----------|
| `computation.lines` | Show lines; look for `key === "ECOMMERCE_SCHEME_SPEND"` |
| `ecommerceSchemeNotes` | Info list above submit (“checkout expired — balance restored”, etc.) |
| `blockers` | `ECOMMERCE_SCHEME_HOLD_ACTIVE` — disable submit, explain wait for delivery |
| `blockers` | `SCHEME_SETTLED_VIA_ONLINE_SHOP` — no cash payout; scheme fully used online |

## Submit `POST /app/schemes/:id/redemption-requests`

May fail with `SCHEME_FUNDS_USED_ONLINE` while a shop hold exists or balance is online-only. Show server `message` verbatim (includes ₹ remainder when applicable).

## Shop checkout flow (customer)

1. Quote → `scheme-preview` → place order (creates redemption `REQUESTED` + `HELD` reservation).
2. Until delivery: passbook notes **reserved**; settlement quote still gross unless hold blocker.
3. After delivery: ledger debit + `schemeSpend` counts as spend; full use → `status: REDEEMED`.

## Failed checkout

`schemeSpendAttempts` with `outcome: "FAILED"` — show `outcomeLabel`; do **not** reduce “available for redemption” in your own math; trust API preview.

## Related backend doc

[`SCHEME_SHOP_REDEMPTION_EDGE_CASES.md`](./SCHEME_SHOP_REDEMPTION_EDGE_CASES.md)

## Backfill (ops)

Historical deliveries without ledger row:

```bash
node scripts/backfill-ecommerce-scheme-ledger-debits.js --dry-run
node scripts/backfill-ecommerce-scheme-ledger-debits.js --apply
```