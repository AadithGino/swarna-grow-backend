# P5 / P6 — test evidence (exact counts)

Recorded: 2026-11-01 (agent run). Re-run locally before release (P8 gate).

## P5 hedge book (7 tests in `p5-daily-hedge-book.test.js`)

Includes original book/reconcile/HTTP checks plus:

- unclassified journal ≠ ordinary correction
- live wallet projection drift (today’s business date only)
- historical dates skip wallet-document drift (ledger-at-cutoff only)

## P5 phase 8 hedge perimeter (4 tests in `digital-metals-phase8.test.js`)

Unchanged procurement/perimeter matrix.

## P5 combined backend total: **11 tests** (7 + 4)

```bash
cd swarnagrow-backend
LOG_LEVEL=error NODE_ENV=test node --import ./tests/global-test-db-serial.js \
  --test --test-concurrency=1 --test-force-exit --test-reporter=spec \
  tests/p5-daily-hedge-book.test.js tests/digital-metals-phase8.test.js
```

Expected: **11 passing** (7 + 4). Full backend slice including P6 API adds **13** when `p6-payments-needing-attention.test.js` is included in the same command.

## P6 backend (2 tests)

```bash
LOG_LEVEL=error NODE_ENV=test node --import ./tests/global-test-db-serial.js \
  --test --test-concurrency=1 --test-force-exit --test-reporter=spec \
  tests/p6-payments-needing-attention.test.js
```

## P6 frontend (1 test)

```bash
cd SwarnaGrow-Tenant-Admin
npx vitest run src/features/payments/payments-needing-attention-page.test.tsx
```

## P6 workflow coverage (manual / UI)

- Order detail → Returns & cancel: cancellation review → confirm; return stepper; Payments tab refund outcomes
- Money → Payments needing attention (nav badge = `GET /admin/nav-badges`.paymentsNeedingAttention)
- Scheme maturity settlement: 3 steps (entitlement → method → confirm)
- Cash control: submit handover → accept/receipt with variance
