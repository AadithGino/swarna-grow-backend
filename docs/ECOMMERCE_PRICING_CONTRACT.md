# Ecommerce pricing contract (Phase 2 → Phase 3)

## Display estimates (Phase 2)

- One **tax classification → one rate (bps)** per product is sufficient for **displayed** estimates.
- Tax settings **version** is returned on each estimate for audit.

## Before checkout (Phase 3+ — accountant sign-off required)

- Agree **component tax** (which parts of gold / making / stones are taxable).
- Agree **CGST/SGST vs IGST** split and invoice line layout.
- Do not treat Phase 2 `displayTotal` as a legal invoice total.

## Gold rate freshness

- Each purity (18K / 22K / 24K) uses the latest **published** rate with `effectiveAt <= now`.
- Rates older than **7 days** (`ECOMMERCE_GOLD_RATE_MAX_AGE_MS`) block pricing with `GOLD_RATE_STALE` (no silent use of stale rates).

## Fixed price mode

- `basePricePaise` / active **sale** price is **all-inclusive**.
- Making, stone, and other charge fields are **not** added again for FIXED products.

## Offers (V1)

- Only on **GOLD_RATE_BASED** products.
- Discount applies to **making charge only** (fixed paise off or percent off making).
- Offers must not imply a fixed total product price.
