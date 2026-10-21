# Digital Gold & Silver — product and accounting specification

**Status:** Phase 1 entitlements and route shells (no live trading).  
**Playbook:** `SwarnaGrow_Digital_Metals_Cursor_Playbook.md` (repository root).  
**Last updated:** 2026-10-15 (Phase 1).

## 1. Purpose and boundaries

Each **tenant jeweller** sells digital gold/silver to its customers, records metal **entitlements** (customer obligation on the jeweller), procures metal separately, and uses **day-end hedge reporting** to compare customer obligations to hedge position. There is **no external bullion-provider integration** in v1.

| Rule | v1 behaviour |
|------|----------------|
| Purchase vs physical stock | Customer **buys never check or reserve physical bullion stock**. |
| Wallet | Per-customer **metal quantity** accounts (gold/silver, by purity/fineness). **Not** a reloadable INR cash wallet. |
| Double-spend prevention | **Wallet quantity reservations** for concurrent sell / physical redemption / in-flight fulfilment — not stock reservations. |
| Scheme / ecommerce | **Separate domain**. Do not post through `LedgerEntry` (`schemeId` required) or ecommerce checkout stock semantics. |
| Cross-tenant / P2P / scheme transfer | **Out of scope** v1. |
| Rate sources | **Manual tenant-published** digital-metal rates v1; scheme 22K and ecommerce gold rates are **references only** via explicit config, never implicit fallback. |

**Commercial wording (mandatory in customer copy):** Quantity credited after payment is a **recorded entitlement** against the jeweller. It is **not** proof of allocated, insured, independently vaulted, or regulator-protected bullion until the merchant’s approved terms say otherwise. Do not hardcode legal KYC thresholds or regulatory claims in product copy.

**Live trading readiness:** Blocked until tenant **approved tax configuration** exists for each charge type (buy fees, sell fees, minting, delivery, GST lines as applicable). Phase 0 does not assume a default GST treatment.

## 2. Repository integration map (inspected)

Grounding from backend `ecommerce` @ `3df60d8` and portals `ecommerce` @ `a9d83e5` (checkpoint commits). Uncommitted: backend playbook + handoff notes only.

| Concern | Extend (do not replace) |
|---------|---------------------------|
| Plan entitlements | `src/constants/plan-features.js`, `src/lib/feature-entitlements.js`, tenant subscription snapshot/overrides |
| Platform controls | `src/routes/platform.routes.js`, platform validators/services, `src/constants/platform-feature-flags.js` |
| Admin API pattern | `src/routes/admin-*.routes.js`, `authenticate` + `requireSubject("TENANT_USER")` + `tenantScope`, `Permission.*`, `idempotent` middleware |
| Customer API pattern | `src/routes/app.routes.js`, prefix **`/api/v1/app`**, `requireSubject("CUSTOMER")`, `requirePlatformCapability("customerAppEnabled")` |
| Staff / agent | `/api/v1/staff`, branch-scoped roles in `src/constants/permissions.js` |
| Payments | `src/integrations/phonepe.provider.js`, `POST /webhooks/phonepe/:tenantId`, merchant-order routing split (`ecommerce-payment-reference.js`, scheme payment paths in workers) |
| Exact money | `src/lib/money.js` (Decimal.js, integer paise, `percentOfPaiseHalfUp`) |
| Scheme weight | Existing **`weightMg`** (milligrams) on schemes/redemption — **unchanged**; digital metals use **`quantityUg`** (micrograms) |
| Journals | **New** `DigitalMetal*` collections; **do not** reuse `LedgerEntry` |
| Idempotency | `src/middlewares/idempotency.middleware.js`, `src/services/idempotency.service.js` |
| Outbox / workers | `src/workers/processors.js`, maintenance queues, lease patterns (see promotion fanout lessons in `docs/ECOMMERCE_PROMOTION_FCM.md`) |
| Fulfilment utilities | Ecommerce quote/order/handover/pickup helpers — reuse **presentation and evidence patterns**, not stock-gated checkout |
| Contracts | `docs/contract-routes.lock` — digital-metal routes added in Phase 1+ with lock update |
| Portals package | Single app **`swarnagrow-portals`** (Tenant Admin + Customer + Agent + Platform in one Next/TS tree) |

### Resolved URL prefixes (Phase 0)

| Surface | Frontend path | Backend API prefix (proposed) |
|---------|---------------|-------------------------------|
| Tenant admin | `/digital-metals/*` under tenant portal (`portal-routes.ts` — new section `digital-metals`) | `/api/v1/admin/digital-metals/*` |
| Customer | **`/customer/:tenantSlug/digital-metals/*`** (extend `CUSTOMER_ROUTE_SECTIONS` + `customer-router.tsx`) | `/api/v1/app/digital-metals/*` |
| Platform | Existing platform tenant/plan screens | `/api/v1/platform/tenants/:tenantId/...` for entitlement + operational pause |

Customer shop today uses section `shop` → `/customer/.../shop`; digital metals is a **parallel module**, not nested under shop.

## 3. Asset identity and precision

| Field | Type | Notes |
|-------|------|--------|
| `metal` | `GOLD` \| `SILVER` | Separate assets |
| `finenessPpm` | integer | Parts per million (e.g. 999000 = 99.9%). Store precise fineness, not only marketing labels like `24K`. |
| `quantityUg` | safe integer | 1 gram = **1_000_000** µg |
| Money | integer **paise** | All INR totals/settlements |
| Calculations | **decimal.js** | Convert to integer paise/µg at defined rounding steps only |

**Bounds (v1):**

- `0 ≤ quantityUg ≤ 10_000_000_000` per wallet line (10 kg) unless tenant limit lowered in settings.
- Rate: `1 ≤ customerBuyRatePerGramPaise ≤ 100_000_000` (₹1M/g cap guardrail).
- Quote outputs must reject non-positive net metal or non-positive payable after rounding.

**Serialization:** API returns `quantityUg` and large totals as **decimal strings** if JSON number would exceed safe integer; portals adapters parse to bigint/Decimal for display only.

## 4. Wallet projections

Per `(tenantId, customerId, metal, finenessPpm)`:

| Measure | Definition |
|---------|------------|
| `heldUg` | Sum of credited lots minus debits (projection) |
| `reservedUg` | Active reservations (sell pending, redemption in fulfilment, etc.) |
| `availableUg` | `heldUg - reservedUg` (≥ 0 enforced) |
| Pending buy | Shown separately; **excluded** from spendable until payment finalization credits metal |

**Acquisition lots:** Immutable lot rows with `quantityUg`, `acquiredAt`, optional `costBasisPaisePerGram` for reporting — required for holding-period rules. Reservation allocation selects eligible lots in **FIFO** order (oldest `acquiredAt` first) unless tenant setting specifies otherwise (v1 default: **FIFO**).

## 5. Rates and quotes (frozen semantics)

### Rate records

- Fields: `customerBuyRatePerGramPaise`, `customerSellRatePerGramPaise` (may be equal or spread).
- Immutable **version** per publish; `effectiveAt`, `publishedAt`, `source: MANUAL`, `maxAgeSeconds` enforced at quote time.
- Stale rate → quote rejected with `STALE_RATE`.

### Quote snapshot (immutable once accepted)

Includes: `quoteId`, asset, rate version ids, settings version, terms version, calculation version, input mode (`BUDGET_INR` | `QUANTITY_UG`), all fee/tax line items, `metalQuantityUg`, `payablePaise` / `settlementPaise`, `expiresAt`.

**Published changes do not rewrite accepted orders.**

### Fee types (independent buy / sell)

| Type | Config |
|------|--------|
| `NONE` | — |
| `FLAT_INR` | paise |
| `PERCENT` | 0–100, optional min/max paise |

Minting (redemption): flat per denomination, per-gram paise, or percent of documented base — configured per catalogue item.

Delivery: flat, zone table, or weight-based — v1 supports **flat + zone id** at minimum.

### Calculation order (frozen)

1. **Input resolution**
   - **Quantity mode:** `metalSubtotalPaise = roundHalfUp(quantityUg * ratePerGramPaise / 1_000_000)`.
   - **Budget mode (default customer UX):** Treat input as **total all-in payable budget** including fees and taxes on buy. Solve for maximum `quantityUg` such that `totalPayablePaise ≤ budgetPaise` using buy rate and fee/tax rules below (binary search or closed form with final downward adjustment). Expose **`budgetRemainderPaise`** (unused budget) explicitly in quote DTO.
2. **Platform/service fee** on **metal subtotal paise** (buy or sell side per config).
3. **Tax lines** — each configured line specifies **base** (`METAL_SUBTOTAL` | `FEE` | `MINTING` | `DELIVERY` | `TOTAL_EXGST`) and rate; computed with `percentOfPaiseHalfUp` pattern from `money.js`. Tax is **not** a hidden discount on fees.
4. **Total payable (buy)** or **net settlement (sell)** = metal subtotal ± fees ± taxes per direction rules.

**Display:** Customer UI labels **Buy** vs **Sell** using the respective rate fields.

### Time windows (defaults — tenant-configurable in Phase 2)

| Event | Default |
|-------|---------|
| Buy quote → payment acceptance | **15 minutes** |
| Sell quote → customer confirmation | **15 minutes** |
| Sell confirmed → staff approval (rate lock) | **30 minutes** additional |

**Quote expiry vs sell-approval expiry (frozen — not implemented until Phase 4/5):**

- **Buy quote:** `expiresAt` is the only window for accepting the immutable snapshot and starting payment. There is **no implicit extension** or silent repricing after `expiresAt`. A new quote requires a fresh rate/settings/terms snapshot.
- **Sell quote (customer confirmation):** Same rule — confirmation must occur before the sell quote `expiresAt`. Expiry **releases the reservation** (pre-execution only); the customer must request a new quote at current published rates.
- **Sell rate lock (post-confirmation):** After the customer confirms, a separate **`approvalExpiresAt`** (default +30 minutes from confirmation) binds the **confirmed** metal quantity and settlement paise to the snapshot already stored on the sell order. Staff approval must complete before `approvalExpiresAt`. There is **no automatic extension**; timeout moves the order to **`EXPIRED`**, releases the reservation, and requires a **new customer quote** — approvers cannot approve at a different price or quantity.
- **Binding moment:** Prices become binding when the customer **accepts** the quote (buy: order create + payment intent; sell: confirm endpoint). Staff approval **attests** execution at the locked snapshot; it does not renegotiate rates.

Late payment success **never** silently reprices or credits fewer grams: **refund / manual review** path with evidence.

## 6. Operation state machines (summary)

Detailed transitions live in `DIGITAL_METALS_API_CONTRACT.md`. Ownership:

| Domain | Terminal failure handling |
|--------|---------------------------|
| Buy order | `EXPIRED`, `PAYMENT_FAILED`, `REFUND_PENDING`, `CREDITED` (once) |
| Sell order | Reservation **released** only before execution; after execution **payable remains** if payout fails |
| Payout | `PENDING_APPROVAL` → `APPROVED` → `SUBMITTED` → `SETTLED` \| `FAILED` \| `UNKNOWN` (blocks duplicate disbursement) |
| Redemption | Reserve → charge paid → fulfilment → **handover event** consumes metal |
| Procurement | Journal entries; **does not gate** customer buy |

**Operational pause** (platform/tenant): blocks **new** buy/sell/redemption requests; must **not** hide existing holdings, open payables, or block settlement/refund workers.

## 7. Physical redemption accounting

- **No stock prerequisite** for listing; catalogue = available to order with disclosed lead time.
- **Minting/delivery charges:** collected in **INR via gateway** (default); not by deducting extra grams.
- **Handover event** (pickup scan or delivery proof): single atomic **consumption** of reserved µg + hedge **physical out** on obligation perimeter (see §8).
- **Dispatch alone** does not reduce customer obligation or hedge obligation line — track **in-transit** separately.
- RTO/loss: exception states; **no automatic** return of spendable metal without verified return + reversal entries.

## 8. Hedge report perimeter (IST business day)

Timezone: **`Asia/Kolkata`** (same as `src/lib/date.js` / gold-rate notifications).

For each `(tenantId, metal, finenessPpm)` and business date **D**:

```
closingObligationUg =
  openingObligationUg
  + completedCustomerBuyUg
  - executedSellBackUg
  - completedPhysicalHandoverUg
  ± obligationAdjustmentUg

closingHedgePositionUg =
  openingHedgePositionUg
  + executedProcurementReceiptUg
  - supplierDisposalUg
  - completedPhysicalHandoverUg
  ± hedgeAdjustmentUg

uncoveredUg = closingObligationUg - closingHedgePositionUg
```

| Event | Obligation | Hedge position |
|-------|------------|----------------|
| Customer buy credited | + | — |
| Customer sell executed | − | — (not physical inflow) |
| Procurement receipt | — | + |
| Physical handover completed | − | − |
| Wallet reservation / minting charge paid | **no change** | **no change** |
| In-transit dispatch | shown separately | shown separately |

**Opening hedge position:** If missing for a metal/purity, report **`coverageIncomplete: true`** — do **not** treat uncovered as zero.

**Snapshots:** Versioned day-end snapshot + provisional live view; backdated corrections create **adjustment rows** and revised snapshot versions, not silent edits.

### 8.1 Manual obligation / hedge adjustments (U4 — policy only in Phase 1)

Manual **`obligationAdjustmentUg`** and **`hedgeAdjustmentUg`** rows are **not implemented** in Phase 1. When built (Phase 8+):

| Rule | Requirement |
|------|-------------|
| Maker vs approver | User who creates the adjustment proposal **cannot** approve it (`digital-metals.adjustment.write` for propose; separate approver permission or paired workflow). |
| Evidence | Each proposal stores **immutable** evidence upload ids, reason code, and before/after perimeter context; evidence attachments are not replaced in place. |
| Reversal | Corrections use a **new audited reversal entry** linked to the original adjustment id; original rows are never deleted or overwritten. |
| Scope | Tenant-scoped; branch-scoped operators may propose only for metals/customers in branch scope. |

**U1 / U2** remain live-trading blockers; **U3** incomplete opening hedge data; **U5** branch rate overrides post-v1.

**Custody/location:** Phase 8 must record `locationCode` on procurement and handover events; Phase 0 default — single tenant vault code `PRIMARY` until multi-location configured.

## 9. Payout v1 (manual)

- Customer bank destinations: tenant-scoped, masked DTO, encrypted at rest, states `PENDING_VERIFICATION` | `ACTIVE` | `DISABLED`.
- **No automated bank verification API** in v1 — staff manual verification with evidence upload.
- Payout: **maker** creates instruction + evidence → **different authorized user** approves (`digital-metals.payout.approve` permission) → record bank reference, settlement date, amount.
- Bank reference alone is **not** proof of credit — `SETTLED` requires maker-entered confirmation + approver attestation.
- Unknown bank outcome → `UNKNOWN`, blocks second disbursement until reconciled.

### 9.1 Spent-metal chargeback and scoped payment-exception holds

When buy payment is disputed after metal was **credited and subsequently sold or redeemed**, the platform must **not** invent a negative metal lot or silent ledger reversal if the metal no longer exists in the customer wallet.

| Step | Policy |
|------|--------|
| Exposure | Record **INR outstanding exposure** (payable/debt) and optional `unrecoverableMetalUg` on the risk hold for audit — not a fake credit reversal. |
| Hold | `CHARGEBACK` on credited exposure → `holdScope: TRADING`, blocks sell and redemption until resolved. |
| Recovery | Authorized staff paths: customer-funded recovery, manual INR settlement, or **write-off** with evidence — each append-only in hold/order audit. |
| LATE_SUCCESS / DUPLICATE (uncredited buy) | `holdScope: REFUND_CASE` tied to `relatedRefundCaseId`; **does not** block sell/redemption (uncredited payment awaiting refund, not holdings exposure). |
| Resolution | Resolving one refund-case hold **must not** clear unrelated TRADING holds or other refund cases. |

Payout `permittedActions` and masked `destinationSnapshot` are returned on admin list/detail DTOs; settlement remains staff-attested with immutable `statusHistory`.

## 10. Permissions (proposed — Phase 1)

New keys (prefix `digital-metals.`):

| Permission | Use |
|------------|-----|
| `digital-metals.read` | Wallets, orders read |
| `digital-metals.settings.write` | Fees, taxes, module settings |
| `digital-metals.rates.write` | Publish rates |
| `digital-metals.sell.approve` | Approve sell execution |
| `digital-metals.payout.record` | Maker payout instruction |
| `digital-metals.payout.approve` | Approver (must differ from maker) |
| `digital-metals.redemption.fulfil` | Packing, dispatch, pickup |
| `digital-metals.procurement.write` | Procurement journal |
| `digital-metals.report.read` | Hedge reports |
| `digital-metals.adjustment.write` | Controlled obligation/hedge adjustments (maker ≠ approver — see §8.1) |

Branch scope: customer wallet reads and fulfilment actions respect existing branch rules where customer `branchId` applies; tenant-wide rates/h settings default **tenant scope**.

Platform users: configure entitlement and view aggregate health — **no** silent balance edits.

## 11. Proposed persistence (Phase 3+ — names only)

Collections (indicative):

- `DigitalMetalAssetSettings`, `DigitalMetalRateVersion`, `DigitalMetalWallet`, `DigitalMetalLot`, `DigitalMetalQuantityJournal`, `DigitalMetalReservation`, `DigitalMetalBuyOrder`, `DigitalMetalSellOrder`, `DigitalMetalPayable`, `DigitalMetalBankDestination`, `DigitalMetalPayout`, `DigitalMetalRedemptionCatalogItem`, `DigitalMetalRedemptionOrder`, `DigitalMetalProcurementEntry`, `DigitalMetalHedgeSnapshot`, `DigitalMetalQuote`.

Indexes: `(tenantId, customerId, metal, finenessPpm)` unique on wallet; journal `(tenantId, walletId, sequence)` unique; reservation partial on active states; hedge snapshot `(tenantId, businessDate, metal, finenessPpm, version)`.

## 12. Numerical acceptance examples

Reference implementation: `tests/digital-metals-acceptance-examples.test.js` (Phase 0 — pure functions, no Mongo).

| # | Scenario | Key assertion |
|---|----------|----------------|
| A1 | Same buy/sell rate ₹6,000/g, no fee, buy ₹6,000 budget | 1.000000 g credited (1_000_000 µg) |
| A2 | Buy ₹6,100/g, sell ₹6,000/g, 1g sell | Settlement 6,000 ₹ before fees |
| A3 | Buy 1% fee min ₹50 on ₹6,000/g × 1g | Fee ₹60 (1% of 600000 paise), total ₹6,060 |
| A4 | Buy 1% fee min ₹50 on ₹4,000/g × 0.5g | Metal ₹2,000; 1% = ₹20 → **min fee ₹50** → total ₹2,050 |
| A5 | Budget ₹1,000 all-in, rate ₹6,000/g, no fee | Quantity floor such that payable ≤ ₹1,000; remainder explicit |
| A6 | Sell executed; payout FAILED | Metal debited; payable ₹ outstanding; available does not restore |
| A7 | Wallet 5g; redeem 2g coin | Reserve exactly 2_000_000 µg; available 3g |
| A8 | Hedge day: open 0/0; buy 3g; sell 1g; handover 1g; procure 2g | Obligation 2g; hedge 1g; uncovered 1g |

## 13. Dependencies on recent FCM / promotion work

Checkpoint `3df60d8` promotion pipeline (lease-fenced fanout, dispatch reconciliation) is **orthogonal** but sets patterns for Phase 10 notification recovery. Do not route digital-metal payments through promotion broadcasts.

## 14. Unresolved business decisions (flagged)

| Topic | Phase 0 default | Needs merchant sign-off |
|-------|-----------------|-------------------------|
| GST / tax bases per charge type | Config structure only; **no live orders** without `taxProfileApprovedAt` | Rate tables per state/product HSN |
| Holding-period sell restrictions | None in v1 unless configured | Marketing/regulatory |
| Exposure limit (INR) optional guard | Off by default | Risk policy |
| Multi-location custody | `PRIMARY` only | Branch vault mapping |
| Jewellery exchange (later playbook §7) | Out of scope | Dedicated contract |
| Opening hedge import | Manual approved journal | Day-one go-live data |

## 15. Regression commands (baseline)

See `docs/DIGITAL_METALS_PROGRESS.md` for recorded Phase 0 check results and phase-targeted commands.
