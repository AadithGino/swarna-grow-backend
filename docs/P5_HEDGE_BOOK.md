# P5 — Daily hedge book + lightweight dashboard balances

**Status:** Implemented (2026-11-01)

## Product rules

- **Daily hedge book** = opening metal owed + credited buys − executed sells − physical handovers ± genuine journal corrections = closing metal owed (per metal/fineness, IST business date).
- **As-of reconciliation:** `ledgerHeldUg` at cutoff (reservations stay inside held) vs calculated closing; `ledgerReconcileDeltaUg` exposes mismatch.
- **Unclassified journals:** empty/unknown `referenceType` → `unclassifiedJournalUg` (not lumped into `correctionUg`).
- **Wallet projection drift:** `walletStoredHeldUg` vs journal-replayed `ledgerHeldUg` at the same cutoff → `walletProjectionDriftUg` (live business date only; historical dates set `walletProjectionDriftApplicable: false` because current wallet documents cannot represent an earlier cutoff).
- **No mandatory close/save** — `GET …/hedge/live` computes on demand. Legacy `close-day` snapshots remain for history only.
- **Procurement/backing** is not in the book and **not in everyday nav** (deep links / legacy API only).
- **Overview cards** use `GET …/dashboard/wallet-totals`, not hedge live.

## Code

- `src/lib/digital-metals-daily-hedge-book.js` — book engine
- `src/services/digital-metals-hedge.service.js` — `getLiveHedgeReport` → `reportType: DAILY_HEDGE_BOOK`
- `src/services/digital-metals-summary.service.js` — `getAdminDigitalMetalsWalletTotals`

## Tests

```bash
LOG_LEVEL=error NODE_ENV=test node --import ./tests/global-test-db-serial.js \
  --test --test-concurrency=1 --test-force-exit --test-reporter=spec \
  tests/p5-daily-hedge-book.test.js tests/digital-metals-phase8.test.js
```
