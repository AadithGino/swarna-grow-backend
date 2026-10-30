# Counter trades (staff-assisted Digi Gold & store orders)

Admins and branch managers can trade for a customer who is standing at the counter. Every counter
trade reuses the customer services (pricing, terms, GST, stock, ledger, invoices, notifications), so it
behaves exactly like an app trade and shows up in the normal lists, reports and customer passbook.

All `POST` endpoints need `X-Idempotency-Key` (8–128 chars). Re-sending the same key returns the same
result, so a dropped connection can be retried safely.

## Permissions

| Permission | Who has it by default | Lets you |
| --- | --- | --- |
| `digital-metals.assisted.trade` | Owner, admin, branch manager | Buy / sell Digi Gold for a customer, pay cash for a counter sell |
| `ecommerce.assisted.order` | Owner, admin, branch manager | Place a store order for a customer, paid in store |
| `digital-metals.sell.approve` (existing) | Owner, admin, branch manager | Approve sells (counter sells too) |

Branch managers only reach customers in their own branch.

## Digi Gold — buy (paid at the counter)

1. `POST /api/v1/admin/digital-metals/customers/:customerId/counter/buy-quote`
   Body is the same as the customer buy quote:
   `{ metal: "GOLD"|"SILVER", finenessPpm: 999000, inputMode: "BUDGET_INR"|"QUANTITY_UG", budgetPaise?, quantityUg? }`
   → quote (rate, grams, fee, GST, `totalPayablePaise`, `expiresAt`).
2. `POST /api/v1/admin/digital-metals/customers/:customerId/counter/buy`
   `{ quoteId, paymentMode: "CASH"|"UPI"|"CARD", paymentReference?, note?, customerConsent: true }`
   - `paymentReference` is required for UPI (UTR) and CARD (slip / approval number).
   - The order is created, marked paid and **credited immediately**; the receipt and GST invoice
     go out through the normal outbox.
   - `CASH` adds the amount to the acting staff member's cash in hand (Cash control) as a
     `CashAdjustment` CREDIT. Owners/admins are not cash custodians, so nothing is posted for them
     (`cashCustody: "OWNER"`).
   → `{ order, cashCustody: "STAFF"|"OWNER"|null }`. Orders carry `channel: "COUNTER"` and an `assisted` block.

Counter quotes (`quoteSource: "ASSISTED"`) cannot be used from the customer app and vice versa.

## Digi Gold — sell (needs approval; cash or bank payout)

1. `POST /api/v1/admin/digital-metals/customers/:customerId/counter/sell-quote`
   `{ metal, finenessPpm, quantityUg }`
2. `POST /api/v1/admin/digital-metals/customers/:customerId/counter/sell`
   `{ quoteId, payoutMethod: "BANK"|"CASH", bankDestinationId? (required for BANK, must be verified), note?, customerConsent: true }`
   → grams are reserved and the sell goes straight to **PENDING_APPROVAL** (the existing
   "Sells to approve" queue, `POST /admin/digital-metals/sell-orders/:orderId/approve`).
3. After approval:
   - `BANK`: create the payout in Digi Gold → Payouts as today (maker-checker).
   - `CASH`: `POST /api/v1/admin/digital-metals/sell-orders/:orderId/cash-payout` `{ receiptNote? }`
     settles the payable (`settlementMethod: "CASH"`) and records a `CashAdjustment` DEBIT for a staff
     custodian. Bank payout instructions are refused for cash sells (`CASH_PAYOUT_ORDER`).

Sell orders now return `payoutMethod` and `assisted`; the customer payout-status endpoint returns
`payoutMethod`, `cashPaid` and `cashPaidAt`.

## Store order paid in store

1. `GET /api/v1/admin/customers/:customerId/ecommerce/counter/options`
   → pickup branches, default pickup branch, delivery availability, the customer's saved addresses, tax readiness.
2. `POST /api/v1/admin/customers/:customerId/ecommerce/counter/quote`
   `{ lines: [{ productId, quantity }], fulfilmentMode: "BRANCH_PICKUP"|"DELIVERY", pickupBranchId?, addressId? }`
   → priced quote (stock reserved for the quote window). The customer's own cart is not touched.
3. `POST /api/v1/admin/customers/:customerId/ecommerce/counter/orders`
   `{ quoteId, paymentMode: "CASH"|"UPI"|"CARD", paymentReference?, note?, customerConsent: true }`
   → order created and marked **PAID** (stock consumed, invoice/notifications via the normal outbox).
   The online payment gateway does not need to be configured; checkout tax settings do.
   Hand-over is then recorded on the order as usual.

## Summaries

- `GET /api/v1/admin/digital-metals/customers/:customerId/summary` — holdings per metal valued at today's
  sell rate, bought/sold totals, pending sells, payouts due (incl. cash), current rates.
- `GET /api/v1/admin/customers/:customerId/ecommerce/summary` — orders, spent, open orders, pieces bought,
  counter orders, latest order.
- `GET /api/v1/admin/digital-metals/dashboard-summary?period=THIS_MONTH|...&from&to&branchId` — vault value,
  holders, period buys/sells (incl. counter), net inflow, new investors, queues and a 14-day trend.
  Branch roles see their branch only.
