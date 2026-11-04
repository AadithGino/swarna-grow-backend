# P7 — Customer / mobile compatibility (executed)

**Run date:** 2026-11-01 (agent-run; re-run locally to verify).

## Code fixes in this slice

| Area | Change |
|------|--------|
| Customer shop timeline | Pickup final step label **Handed over at store** (never **Collected**); handover step completes only on `DELIVERED`; customer code ack shows staff-handover subcopy without completing the step |
| P5 hedge live | `walletProjectionDriftApplicable` only when cutoff is **end-of-business-day** for today; mid-day `asOf` uses ledger-at-cutoff only; `getLiveHedgeReport` reads inside a **transaction** when no session is passed |

## Journey / payload matrix

| Journey | Payload / surface checked | Result |
|---------|----------------------------|--------|
| Pickup customer ack | `POST /app/shop/orders/:id/confirm-pickup` — status stays `READY_FOR_PICKUP`, no `FULFILMENT_HANDOVER_RECORDED` | **Pass** (`p2-ecommerce-fulfilment.test.js`) |
| Pickup staff handover | `POST .../confirm-pickup-collection` with `staffHandoverConfirmed: true` + customer code → `DELIVERED` | **Pass** (`p2`) |
| Legacy staff challenge | `POST .../staff-handover-challenge/reveal` code rejected for admin collection (422) | **Pass** (`p2`) |
| Customer timeline (UI) | `buildShopOrderTimeline` — no **Collected** label; ack without `DELIVERED` keeps handover step upcoming | **Pass** (`customer-shop-order-progress.test.ts`) |
| COD pickup delivered, cash pending | Last timeline step stays **current**, not all-complete | **Pass** (vitest) |
| Sell payment progress | `paymentDisplayState`: awaiting acceptance → unpaid → partially paid → paid; in-flight payout → payment being checked | **Pass** (`p7-customer-mobile-compatibility.test.js`, `p1-digital-metals-sell-payment.test.js`) |
| Buy / payment reload | Harness buy credit + charge-paid paths | **Pass** (`p4-digital-metals-buy-redemption-fulfilment.test.js`) |
| Zero-charge redemption | Reaches charge-paid without payment intent | **Pass** (`p4`) |
| Physical handover (DM redemption) | Staff attestation + single metal consumption | **Pass** (`p4`) |
| Flutter contract (static) | Paise/`quantityUg` string fields, existing app routes documented in `FLUTTER_CUSTOMER_ECOMMERCE_AND_DIGITAL_METALS_INTEGRATION.md`; sell detail `paymentDisplayState` keys unchanged | **Pass** (doc + API tests above; no new breaking fields) |
| P5 same-day `asOf` | Mid-day cutoff: `walletProjectionDriftApplicable: false`, ledger at cutoff unchanged | **Pass** (`p5-daily-hedge-book.test.js`) |

## Commands (P7 subset)

```bash
# backend
LOG_LEVEL=error NODE_ENV=test node --import ./tests/global-test-db-serial.js --test --test-concurrency=1 --test-force-exit \
  tests/p2-ecommerce-fulfilment.test.js tests/p1-digital-metals-sell-payment.test.js \
  tests/p4-digital-metals-buy-redemption-fulfilment.test.js tests/p5-daily-hedge-book.test.js \
  tests/p7-customer-mobile-compatibility.test.js

# tenant admin (customer + admin smoke)
cd ../SwarnaGrow-Tenant-Admin && npx vitest run src/features/customer/customer-shop-order-progress.test.ts
```

**Reported P7 backend subset:** 39 tests, 0 failures (single serial run).

## P8

See `docs/P8_RELEASE_GATE.md`.
