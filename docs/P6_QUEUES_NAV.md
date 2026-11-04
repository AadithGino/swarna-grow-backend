# P6 — Unified queues & navigation

## Payments needing attention

- **API:** `GET /admin/payments/needing-attention?limit=` — merges ecommerce payment exceptions and digital-metal buy payment exceptions when the caller has the respective read permissions.
- **Admin UI:** `/payments/needing-attention` (Money nav). Legacy `/ecommerce/payment-exceptions` and `/digital-metals/payment-exceptions` render the same page.
- Each row includes: domain, reason, amount (paise), customer, next action, link to source transaction, and optional **refund obligation** (separate per domain/refund case).

## Other P6 surfaces

- **Inline bank verification:** customer bank panel + sell order bank panel (`Verify for payout`).
- **Scheme settlement:** preview → method → confirm copy; penalty/forfeiture acknowledgements on premature closure and maturity redeem.
- **Cash handover:** submit dialog describes submit → recipient receipt → discrepancy resolution.
- **Store settings:** tabbed gold rates / GST / fulfilment under Store settings; digital metals rates/fees/quote tabs under Rates & settings.
- **Setup checklist:** dashboard `SetupChecklist` with actionable Open / Show me links.

## Tests

```bash
LOG_LEVEL=error NODE_ENV=test node --import ./tests/global-test-db-serial.js \
  --test --test-concurrency=1 --test-force-exit --test-reporter=spec \
  tests/p6-payments-needing-attention.test.js
```

See `docs/P5_P6_TEST_EVIDENCE.md` for exact P5/P6 test counts and commands.
