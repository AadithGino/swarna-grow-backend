# Scheme shop checkout × redemption — edge cases & build order

Reference for **matured scheme** value spent via **online shop** vs **counter redemption** (cash, gold handover, in-store purchase adjustment).

**Related code**

| Area | Paths |
|------|--------|
| Reservations | `src/services/ecommerce-scheme-reservation.service.js`, `src/models/ecommerce-scheme-reservation.model.js` |
| Net spend / encumbrance | `src/lib/ecommerce-scheme-net-spend.js` |
| Spend history / classify | `src/lib/ecommerce-scheme-spend-history.js`, `src/lib/ecommerce-scheme-spend-classify.js` |
| Settlement preview | `src/lib/ecommerce-scheme-settlement-preview.js`, `src/services/redemption.service.js` |
| Auto-close full shop | `src/lib/ecommerce-scheme-online-closure.js` |
| Orders / expiry | `src/lib/ecommerce-pending-payment-policy.js`, `src/lib/ecommerce-order-lifecycle.js` |
| Admin / customer UI | `SwarnaGrow-Tenant-Admin` — `settlement-lines-panel`, `scheme-shop-balance.tsx`, passbook |

---

## Mental model

```text
NOT SPEND          → failed / expired / cancelled checkout (hold RELEASED, redemption REJECTED)
RESERVED (HELD)    → approved or paid but not yet delivered / picked up
SPENT (CONSUMED)   → delivery or pickup completed; redemption COMPLETED for order
LEDGER DEBIT       → only on branch `completeRedemption` (in-store path), not on ecommerce CONSUMED
```

Passbook **payment rows** reflect installments; **shop use** is tracked via **reservations + redemption rows**, not always as `REDEMPTION_DEBIT`.

---

## Edge case catalog

### A. Lifecycle timing

| State | Reservation | Redemption | Maturity quote |
|-------|-------------|------------|----------------|
| Awaiting jeweller approval | HELD | REQUESTED | Full gross; note “reserved” |
| Approved, awaiting top-up payment | HELD | REQUESTED / APPROVED | Full gross; hold blocks counter payout |
| Paid, not delivered | HELD | APPROVED | Full gross until delivery; classify “fulfilment in progress” |
| Delivered / pickup done | CONSUMED | COMPLETED | Deduct **net** consumed; may close scheme if ₹0 left |
| Expired / rejected / cancelled | RELEASED | REJECTED | Full gross (correct) |

### B. Failed checkouts

No ledger debit and no CONSUMED units. UI must show attempts under **“Shop checkouts that did not complete”** and settlement notes that balance was **restored**.

### C. Partial vs full online use

- **Partial:** `CONSUMED` net units reduce `getSchemePurchaseEntitlement`; remainder often **online-only** (`SCHEME_FUNDS_USED_ONLINE` on counter cash).
- **Full:** After delivery, preview settlement ₹0 → blocker `SCHEME_SETTLED_VIA_ONLINE_SHOP`; scheme may auto-**`REDEEMED`** (`ONLINE_SHOP_FULL` audit).

### D. Returns after delivery

`restoredUnits` on reservation reduces **net** spend. Spend rows and settlement preview must use **net**, not original `appliedPaise` snapshot.

### E. Basis & multi-order

- Cannot mix **CASH_VALUE** and **GOLD_WEIGHT** allocations (`SCHEME_SETTLEMENT_BASIS_IN_USE`).
- `balanceAtReservation` can cap later quotes.
- Benefit and making-charge waiver caps are shared across reservations.

### F. Scheme invalidation mid-checkout

If scheme status changes before ship/deliver → `SCHEME_BACKING_CHANGED`. Payment capture may cancel order, release hold, reject redemption, refund top-up. **Stuck PAID + invalid scheme** may need manual admin cancel (backlog).

### G. Channel settings

- `schemeCheckoutEnabled: false` blocks **new** previews unless scheme already has online allocation (`schemeHasOnlineAllocation`).
- COD quotes cannot use scheme checkout.
- Ecommerce-linked redemptions: staff redemption UI → `MANAGE_REDEMPTION_FROM_ORDER`.

### H. Double authority

- Branch cannot complete ecommerce-linked redemption from redemption screen.
- Ecommerce `CONSUMED` does not write `REDEMPTION_DEBIT` (avoids double debit with preview deduction).

---

## Build order (implemented)

| Phase | Goal | Status |
|-------|------|--------|
| 0 | Net spend from reservations (`units - restoredUnits`) | Done |
| 1 | Maturity preview: deduct net CONSUMED, notes for failed/pending, hold blockers | Done |
| 2 | Spend history uses reservation net; returns zero out spend | Done |
| 3 | Classify labels: paid + fulfilment vs awaiting payment | Done |
| 4 | Auto `REDEEMED` when full shop use after delivery | Done |
| 5 | Passbook `onlineEncumbrance.summaryLines` | Done |
| 6 | `SCHEME_FUNDS_USED_ONLINE` messages with remainder/hold detail | Done |
| 7 | Admin settlement notes + customer encumbrance panel | Done |

---

## API fields (customer / admin)

**Scheme detail / passbook**

- `schemeSpend` — completed shop uses (`countsAsSpend`)
- `schemeSpendAttempts` — all attempts including failed/pending
- `shopBalanceSummary` — used + still for shop (entitlement)
- `onlineEncumbrance` — passbook footnotes (reserved vs consumed vs ledger)

**Settlement preview**

- `computation.lines` — may include `ECOMMERCE_SCHEME_SPEND` (net)
- `ecommerceSchemeNotes` — explanatory bullets
- `blockers` — e.g. `ECOMMERCE_SCHEME_HOLD_ACTIVE`, `SCHEME_SETTLED_VIA_ONLINE_SHOP`

---

## Verification checklist

1. **Expired scheme order** — maturity quote still full; failed attempt listed; note explains restore.
2. **Full scheme checkout** — approve → (pay if top-up) → deliver → scheme `REDEEMED`, cash redemption blocked, passbook encumbrance lines.
3. **Partial checkout + return** — net spend decreases; maturity quote matches remainder.
4. **Paid, not delivered** — pending label; cash/gold handover preview blocked while HELD.
5. **Counter redemption with online allocation** — clear error with ₹/g remainder or hold message.

Demo context: see `SwarnaGrow-Tenant-Admin/docs/DEMO_CREDENTIALS.md` and `scripts/patch-sachu-matured-scheme-checkout.js`.

---

## Phase 8 (implemented)

| Item | Implementation |
|------|----------------|
| Ledger `REDEMPTION_DEBIT` on ecommerce `CONSUMED` | `recordOnlineShopRedemptionLedgerDebit` (`metadata.source: ONLINE_SHOP`) |
| Preview double-count guard | `sumEcommerceRedemptionLedgerDebits` — only deduct reservation **legacy gap** |
| Stuck scheme-backed orders | `POST /admin/ecommerce/orders/:orderId/scheme/release-backing` + order detail UI |
| `assertStandalone` messaging | Uses live `settlementPreview` + hold blockers |
| Customer / API encumbrance | `onlineEncumbrance` on scheme detail + passbook (Flutter: consume same JSON) |
| Unit test | `tests/ecommerce-scheme-ledger-debit.test.js` |

## Phase 9 (implemented)

| Item | Implementation |
|------|----------------|
| Flutter contract | `docs/FLUTTER_SCHEME_SHOP_REDEMPTION.md` |
| Integration tests | D2 deliver → ledger debit + REDEEMED + passbook/preview; `ecommerce-scheme-phase9-http` backfill dry-run |
| Backfill ledger | `scripts/backfill-ecommerce-scheme-ledger-debits.js` (`--dry-run` / `--apply`) |

---

## Approval & expiry windows

Scheme-only / pending approval uses **`computeSchemePurchaseApprovalExpiresAt`** (default **24h** from `ecommerce-pending-payment-policy.js`). After approval with top-up, payment window resets to standard online pending minutes.

---

*Last updated: 2026-03-25 — aligns with ecommerce scheme spend visibility and settlement preview work.*