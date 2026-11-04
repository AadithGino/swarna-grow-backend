# P4 release evidence — digital buy + physical redemption

**Date:** 2026-11-01  
**Scope:** Simplified redemption fulfilment from `CHARGE_PAID`, staff-verified pickup handover, buy harness path, customer + admin UI wiring.

## Backend test command (authoritative)

Run with no competing `node --test` processes:

```bash
cd swarnagrow-backend
LOG_LEVEL=error NODE_ENV=test node --import ./tests/global-test-db-serial.js \
  --test --test-concurrency=1 --test-force-exit --test-reporter=spec \
  tests/p4-digital-metals-buy-redemption-fulfilment.test.js
```

**Focused P4 file:** 7/7 pass (see full log in `docs/P4_RELEASE_EVIDENCE_BACKEND.txt`).

## Regression cross-checks (protections retained)

Same env as above; appended to `P4_RELEASE_EVIDENCE_BACKEND.txt`:

```bash
LOG_LEVEL=error NODE_ENV=test node --import ./tests/global-test-db-serial.js \
  --test --test-concurrency=1 --test-force-exit --test-reporter=spec \
  --test-name-pattern="late charge|pickup handover|staffHandover" \
  tests/digital-metals-phase7.test.js
```

- **Metal consumed once at handover** — P4 pickup handover test + phase7 `pickup handover consumes metal exactly once`.
- **Pre-dispatch cancel releases reservation** — P4 test 7.
- **Concurrent complete-pickup idempotency** — P4 test 6.
- **Late / duplicate charge success → refund review** — phase7 `late charge success creates refund case`.

## Admin UI (Tenant Admin)

```bash
cd SwarnaGrow-Tenant-Admin
npm run test -- --run src/features/digital-metals/digital-metals-redemption-handover-ui.test.tsx
```

2/2 pass — pickup code + staff attestation gate before submit.

## Worker shutdown

P4 runs use `--test-force-exit` to bound Mongo teardown. **Worker graceful shutdown** is verified at the **P8 full release gate**, not in this slice.

## UI journeys (manual / staging)

| Actor | Journey |
|--------|---------|
| Customer | Buy: budget → review → payment intent → credited (`customer-digital-metals-buy-pages.tsx`) |
| Customer | Redeem: catalogue → review → pay charges (or zero-charge) → timeline + pickup code reveal (`customer-digital-metals-redeem-pages.tsx`) |
| Admin | Redemption detail: Ready for pickup → enter customer code + attestation → Complete pickup; or Ship → attestation → Complete delivery (`digital-metals-redemption-pages.tsx`) |

## Contract

- `docs/DIGITAL_METALS_API_CONTRACT.md` — P4 simplified fulfilment paths and `staffHandoverConfirmed` on complete-pickup.
