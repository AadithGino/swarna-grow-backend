# Digital Gold & Silver — API contract (Phase 0 draft)

**Status:** Phase 8 — procurement journal + IST hedge live/snapshots registered in `docs/contract-routes.lock`. Phase 9 statements/receipt PDFs not implemented.  
**Envelope:** Standard `{ success, data, meta, error }` per `docs/API_CONTRACT.md`.  
**Auth:** Admin routes use tenant user bearer + permissions; customer routes use customer bearer on `/app/*`.  
**Mutations:** Require `X-Idempotency-Key` where noted (same pattern as ecommerce/scheme writes).

## 1. Capability and settings (Phase 1 — live)

### `GET /app/digital-metals/capability`

Customer-facing module gate (entitlement + tenant enable + operational pause + legacy holdings).

```json
{
  "enabled": false,
  "planEntitled": false,
  "tenantEnabled": false,
  "paused": false,
  "hasLegacyActivity": false,
  "canViewHoldings": true,
  "canViewHistory": true,
  "canAccessSettlement": false,
  "canAccessFulfilment": false,
  "canPlaceNewBuy": false,
  "canPlaceNewSell": false,
  "canPlaceRedemption": false,
  "blockers": [{ "code": "MODULE_DISABLED", "message": "..." }],
  "termsVersion": null,
  "termsContentHash": null,
  "taxProfileApproved": false,
  "assets": [
    {
      "metal": "GOLD",
      "finenessPpm": 999000,
      "quoteReady": false,
      "rateTiming": "MISSING",
      "issues": [{ "code": "SETTINGS_MISSING", "message": "..." }]
    }
  ],
  "pause": {
    "tenantPaused": false,
    "tenantPauseReason": "",
    "platformPaused": false,
    "platformPauseReason": ""
  },
  "implementationPhase": 3,
  "workspaceLive": true
}
```

Legacy customers with holdings or open settlement/fulfilment may have `canViewHoldings: true` while `canPlaceNewBuy` remains false when the module is disabled or paused.

### `GET /admin/digital-metals/capability`

Same DTO as customer capability plus `permissions.read` hint for the signed-in admin.

### `GET /admin/digital-metals/workspace`

Requires `digital-metals.read` and server `canViewHoldings`. Returns `{ phase, workspaceLive, title, message, capability }` — Phase 1 placeholder only (no balances).

### `POST /platform/tenants/:tenantId/digital-metals/pause`

Platform body: `{ "pause": true, "reason": "..." }`. Sets `digitalMetalsPlatformPaused` on tenant operations (blocks new trading; does not hide legacy access).

Tenant operations patch (existing settings API): `digitalMetalsEnabled` boolean — requires plan entitlement server-side.

### `GET /admin/digital-metals/settings` (Phase 2)

### `PATCH /admin/digital-metals/settings` (idempotent)

Tenant commercial settings: fee rules, tax lines, quote TTLs, holding period. **`exposureCapPaise` is rejected** (not enforced). Tax approval and terms publication are **platform-only** (fingerprint + immutable **`contentSnapshot`** with server-computed hash; optional `contentRef` is not authoritative).

### Platform: extend existing tenant/plan payloads

- Plan feature key: **`digitalMetals`** (boolean, default **false** all tiers — Phase 1).
- Tenant override + **`digitalMetalsPaused`** with reason (platform or tenant admin).

## 2. Rates

| Method | Path | Permission |
|--------|------|------------|
| GET | `/admin/digital-metals/rates/current` | `digital-metals.read` |
| GET | `/admin/digital-metals/rates/history` | `digital-metals.read` |
| POST | `/admin/digital-metals/rates/publish` | `digital-metals.rates.write` |

**Publish body (draft):**

```json
{
  "metal": "GOLD",
  "finenessPpm": 999000,
  "customerBuyRatePerGramPaise": 610000,
  "customerSellRatePerGramPaise": 600000,
  "effectiveAt": "2026-10-16T04:30:00.000Z",
  "expectedVersion": 3
}
```

**Rate DTO:** `rateVersionId`, `customerBuyRatePerGramPaise`, `customerSellRatePerGramPaise`, `effectiveAt`, `publishedAt`, `maxAgeSeconds`, `source: "MANUAL"`.

## 3. Quotes

| Method | Path | Actor |
|--------|------|-------|
| POST | `/app/digital-metals/quotes/buy` | Customer |
| POST | `/app/digital-metals/quotes/sell` | Customer |
| POST | `/app/digital-metals/quotes/redemption` | Customer |
| POST | `/admin/digital-metals/quotes/preview` | Admin (optional calculator) |

**Buy quote request:**

```json
{
  "metal": "GOLD",
  "finenessPpm": 999000,
  "inputMode": "BUDGET_INR",
  "budgetPaise": 600000,
  "termsVersionAccepted": "2026-10-01"
}
```

**Quote response (shared shape):**

```json
{
  "quoteId": "dmq_...",
  "expiresAt": "2026-10-15T12:15:00.000Z",
  "metal": "GOLD",
  "finenessPpm": 999000,
  "metalQuantityUg": "1000000",
  "metalSubtotalPaise": 600000,
  "feeLines": [{ "code": "PLATFORM_BUY", "amountPaise": 6000 }],
  "taxLines": [],
  "totalPayablePaise": 606000,
  "budgetRemainderPaise": 0,
  "rateSnapshot": { "buyRatePerGramPaise": 610000, "rateVersionId": "dmr_..." },
  "calculationVersion": "2026-10-15.v1"
}
```

Acceptance stores immutable snapshot on order create (Phase 4+).

**Expiry semantics (spec §5):** Buy/sell **quote** `expiresAt` is hard — no extension or repricing. After customer sell **confirm**, a separate **`approvalExpiresAt`** locks the snapshot for staff approval; timeout → `EXPIRED` and new quote required (Phase 5).

## 4. Buy flow

| Method | Path | Notes |
|--------|------|-------|
| POST | `/app/digital-metals/buy-orders` | From accepted quote + explicit terms hash/version |
| POST | `/app/digital-metals/buy-orders/:orderId/payment-intents` | PhonePe initiation (after order persisted) |
| GET | `/app/digital-metals/buy-orders/:orderId/payment-intents/:paymentAttemptId` | Poll attempt |

**Checkout policy (non-production):** `DIGITAL_METALS_CHECKOUT_MODE` = `demo` (default, simulated poll success), `mock`/`PROVIDER_MODE=mock`, or `live` (requires tenant PhonePe credentials). Payment attempts persist `checkoutMode` (`LIVE` \| `MOCK_PROVIDER` \| `DIGITAL_METALS_DEMO`); poll simulates success only for mock/demo modes. Response includes optional `checkoutLabel`.
| GET | `/app/digital-metals/buy-orders` | Customer-owned paginated list (`limit`, `cursor`, `status`); not passbook-derived |
| GET | `/app/digital-metals/sell-orders` | Customer-owned paginated sell list |
| GET | `/app/digital-metals/redemption/orders` | Customer-owned paginated redemption list |
| GET | `/app/digital-metals/orders/open-summary` | Counts of open buy/sell/redemption orders (resume/tracking entry) |
| GET | `/app/digital-metals/buy-orders/:orderId` | Status polling |
| POST | `/app/digital-metals/buy-orders/:orderId/test-harness/complete-payment` | **Test only** (`NODE_ENV=test` + `ECOMMERCE_PAYMENTS_TEST_HARNESS=true`; absent in production) |
| GET | `/app/digital-metals/buy-orders/:orderId/invoice` | PDF when `invoiceStatus=READY` (customer-owned order) |
| GET | `/admin/digital-metals/buy-orders` | Cursor list (`limit`, `cursor`, `status`, `customerId`, `q` order-id prefix); branch-scoped |
| GET | `/admin/digital-metals/buy-orders/:orderId` | Detail + payment attempts |
| GET | `/admin/digital-metals/buy-orders/:orderId/invoice` | Same artifact as customer route (permissioned) |
| GET | `/admin/digital-metals/payment-exceptions` | Late success, duplicate payment, mismatch cases |
| GET | `/admin/digital-metals/buy-orders/:orderId/refund` | Refund case + order snapshot |
| POST | `/admin/digital-metals/buy-orders/:orderId/refund-initiate` | PhonePe refund (`digital-metals.adjustment.write`); idempotent while provider outcome unknown |

**Order statuses:** `QUOTE_ACCEPTED` → `PAYMENT_PENDING` → `PAYMENT_VERIFIED` → `CREDITED` | `EXPIRED` | `REFUND_REVIEW` | `REFUNDED`.

**Invoice:** Outbox topic `PURCHASE_INVOICE_REQUEST` → `invoiceStatus` `PENDING` | `READY` | `FAILED` (failure does not reverse `CREDITED`).

**Payment:** Reuse PhonePe tenant credentials; merchant order id prefix **`DM-BUY-`** (distinct from ecommerce/scheme). Scheduled **`digital-metals-payment-reconcile`** polls stale attempts; **`digital-metals-outbox-dispatch`** processes invoice requests. Refund webhooks recognize **`dmref_`** merchant refund ids.

## 5. Sell flow

| Method | Path | Notes |
|--------|------|-------|
| POST | `/app/digital-metals/quotes/sell` | Customer sell quote (`quantityUg`, sell rate snapshot) |
| POST | `/app/digital-metals/sell-orders` | Accept quote + FIFO lot reservation |
| POST | `/app/digital-metals/sell-orders/:orderId/confirm` | Lock rate; requires **ACTIVE** bank destination |
| POST | `/app/digital-metals/sell-orders/:orderId/cancel` | Pre-execution release |
| GET | `/app/digital-metals/sell-orders/:orderId` | |
| GET | `/app/digital-metals/sell-orders/:orderId/payout-status` | Sale vs bank payout tracking |
| GET | `/admin/digital-metals/sell-orders` | Cursor list (`limit`, `cursor`, `status`, `customerId`, `q`); branch-scoped |
| GET | `/admin/digital-metals/sell-orders/:orderId` | |
| POST | `/admin/digital-metals/sell-orders/:orderId/approve` | `digital-metals.sell.approve` — debits metal, opens INR payable |
| POST | `/admin/digital-metals/sell-orders/:orderId/cancel` | Pre-execution |

**Statuses:** `RESERVED` → `PENDING_APPROVAL` → `PAYABLE_OPEN` | `CANCELLED` | `EXPIRED`. Quote / approval TTLs from tenant settings; no silent extension.

**Risk hold:** Active `DigitalMetalCustomerRiskHold` blocks new sell quotes/orders (`DIGITAL_METALS_RISK_HOLD`) — separate from tenant pause.

## 6. Bank destinations and payouts

| Method | Path |
|--------|------|
| GET/POST/PATCH | `/app/digital-metals/bank-destinations` |
| GET | `/admin/digital-metals/customers/:customerId/bank-destinations` |
| GET | `/admin/digital-metals/bank-verification/queue` | Pending/active/disabled queue; masked last-four/IFSC; branch-scoped |
| POST | `/admin/digital-metals/customers/:customerId/bank-destinations/:destinationId/verify` | Manual staff attestation (`note` required; optional `evidenceUploadIds`; `activate=false` keeps pending) |
| POST | `/admin/digital-metals/customers/:customerId/bank-destinations/:destinationId/disable` | Disable destination (`digital-metals.payout.record`) |
| GET | `/admin/digital-metals/payables` | Open INR liabilities after sale |
| GET/POST | `/admin/digital-metals/payouts` | Maker instruction (`digital-metals.payout.record`) |
| POST | `/admin/digital-metals/payouts/:payoutId/approve` | Approver ≠ maker |
| POST | `/admin/digital-metals/payouts/:payoutId/submit` | Maker records bank submission |
| POST | `/admin/digital-metals/payouts/:payoutId/record-settlement` | Approver attestation + evidence |
| POST | `/admin/digital-metals/payouts/:payoutId/record-failure` | Payable stays open |
| POST | `/admin/digital-metals/payouts/:payoutId/mark-unknown` | Blocks duplicate disbursement |
| POST | `/admin/digital-metals/payouts/:payoutId/resolve-unknown` | Evidenced FAILED/SETTLED resolution; unblocks retry |
| GET/POST | `/admin/digital-metals/customers/:customerId/risk-holds` | Account-level blocks |
| POST | `/admin/digital-metals/risk-holds/:holdId/resolve` | Audited resolution |

**Payout DTO (masked):** frozen `destinationSnapshot`, `status`, `amountPaise`, `sellOrderId`, evidence upload ids. No automated payout provider in v1.

## 7. Redemption

### Catalogue and charge checkout (Phase 6)

| Method | Path |
|--------|------|
| GET | `/app/digital-metals/redemption/catalogue` |
| POST | `/app/digital-metals/quotes/redemption` |
| POST | `/app/digital-metals/redemption/orders` |
| GET | `/app/digital-metals/redemption/orders/:orderId` |
| POST | `/app/digital-metals/redemption/orders/:orderId/payment-intents` |
| GET | `/app/digital-metals/redemption/orders/:orderId/payment-intents/:paymentAttemptId` |
| POST | `/app/digital-metals/redemption/orders/:orderId/cancel` |
| CRUD | `/admin/digital-metals/redemption/catalogue` |
| GET | `/admin/digital-metals/redemption/orders` | Query: optional `status`, `customerId`, `limit` (1–100). Branch-scoped staff only see customers in their branch; `customerId` outside scope → **403**. |
| GET | `/admin/digital-metals/redemption/orders/:orderId` |

Charge payment merchant prefix **`dmrpay_`**. Success finalizes to `CHARGE_PAID` without crediting metal. Late/duplicate success → `REFUND_REVIEW` + `DigitalMetalRedemptionChargeRefundCase` (`dmrref_`).

### Charge refund operations

| Method | Path | Permission |
|--------|------|------------|
| GET | `/admin/digital-metals/redemption/charge-refunds` | read |
| GET | `/admin/digital-metals/redemption/orders/:orderId/charge-refund` | read |
| POST | `/admin/digital-metals/redemption/orders/:orderId/charge-refund/initiate` | payout.record |
| POST | `/admin/digital-metals/redemption/charge-refunds/:refundCaseId/record-manual` | payout.approve |

### Fulfilment (Phase 7)

| Method | Path | Permission |
|--------|------|------------|
| GET | `/admin/digital-metals/redemption/fulfilment/queue` | read |
| POST | `.../fulfilment/accept` | redemption.fulfil |
| POST | `.../fulfilment/packing` | redemption.fulfil |
| POST | `.../fulfilment/delay` | redemption.fulfil |
| POST | `.../fulfilment/dispatch` | redemption.fulfil (manual tracking labelled `MANUAL`); **`X-Idempotency-Key` required**; assigns immutable `shipmentEventId` and enqueues `DISPATCHED` notice in the same transaction |
| POST | `.../fulfilment/pickup-ready` | redemption.fulfil |
| POST | `.../fulfilment/pickup-code` | redemption.fulfil — returns one-time `pickupCode` to staff only |
| POST | `.../fulfilment/complete-pickup` | redemption.fulfil |
| POST | `.../fulfilment/complete-delivery` | redemption.fulfil — requires `approverAttestation: true` |
| POST | `.../fulfilment/cancel` | redemption.fulfil — pre-dispatch only; releases reservation + refund case when charged |
| POST | `.../fulfilment/investigation` | redemption.fulfil |
| POST | `.../fulfilment/resolve-return` | redemption.fulfil — verified return releases reservation |
| POST | `.../fulfilment/replacement-dispatch` | redemption.fulfil — **`X-Idempotency-Key` required**; appends `REPLACEMENT_DISPATCHED` shipment history + customer notice (distinct outbox key `orderId:REPLACEMENT_DISPATCHED:shipmentEventId`); no second metal debit / physical-out |
| GET | `/app/digital-metals/redemption/orders/:orderId/fulfilment` | customer progress |
| GET | `/app/digital-metals/redemption/orders/:orderId/pickup-instructions` | authenticated customer pickup code reveal |

**Order DTO (fulfilment):** `status`, `version`, `permittedActions[]`, `leadTimeDays`, `delayNote`, `carrier`, `trackingReference`, `trackingSource`, `shipmentHistory`, `hasPickupCode` (no hash/sealed fields). Completion creates immutable `DigitalMetalPhysicalOutEvent` (`dmphy_`) and commits reservation exactly once.

## 8. Wallets and passbook

| Method | Path |
|--------|------|
| GET | `/app/digital-metals/portfolio` |
| GET | `/app/digital-metals/passbook` | cursor |
| GET | `/admin/digital-metals/customers/:customerId/wallets` |
| GET | `/admin/digital-metals/customers/:customerId/passbook` |

**Wallet DTO:**

```json
{
  "metal": "GOLD",
  "finenessPpm": 999000,
  "heldUg": "5000000",
  "reservedUg": "2000000",
  "availableUg": "3000000",
  "pendingBuyUg": "0"
}
```

## 9. Procurement and hedge (Phase 8)

Perimeter (per tenant, metal, fineness, IST business date):

`closingObligationUg = opening + buys − sells − handovers ± obligationAdjustments`  
`closingHedgePositionUg = opening + procurementReceipts − disposals − handovers ± hedgeAdjustments`  
`uncoveredUg = closingObligation − closingHedgePosition`

Commitments are reported separately and do not count as received coverage. Missing approved opening → `coverageIncomplete: true` (not zero exposure).

| Method | Path | Permission |
|--------|------|------------|
| GET | `/admin/digital-metals/procurement/entries` | read |
| GET | `/admin/digital-metals/procurement/entries/:id` | read |
| POST | `/admin/digital-metals/procurement/entries` | procurement.write |
| POST | `/admin/digital-metals/procurement/entries/:id/approve` | procurement.approve (≠ creator) |
| GET | `/admin/digital-metals/hedge/live?businessDate=&asOf=` | report.read — IST `businessDate`; optional ISO `asOf` cutoff |
| POST | `/admin/digital-metals/hedge/snapshots/close-day` | report.read — body `businessDate`, optional `revisionReason` |
| GET | `/admin/digital-metals/hedge/snapshots/:businessDate` | report.read |
| GET | `/admin/digital-metals/hedge/snapshots-invalidated` | report.read — invalidated closes requiring re-close |
| GET | `/platform/digital-metals/hedge-health` | platform — aggregate only |

Sources: credited buy orders, executed sells (`PAYABLE_OPEN`), `DigitalMetalPhysicalOutEvent` (IST `businessDate`), approved procurement entries (period carry-forward from last closed snapshot). Wallet reconcile delta uses **journal balances at `asOf`**, not live wallet projection.

Procurement approve body (receipt over-commitment): `{ overReceiptApprove: true, overReceiptApprovalNote: "..." }`.
Close revision response may include `downstreamInvalidatedBusinessDates` when superseding a closed day.

### Durable documents (Phase 9)

Async generation via outbox topic `DIGITAL_METAL_DOCUMENT_ARTIFACT_REQUEST`. Artifacts: `PENDING` → `PROCESSING` → `READY` | `FAILED`. Immutable `sourceSnapshot` captured at request time; `documentNumber` assigned once at first successful render; READY uploads are never replaced.

| Method | Path | Notes |
|--------|------|-------|
| POST | `/app/digital-metals/documents/request` | Body `{ docType, subjectId? \| fromBusinessDate+toBusinessDate }` + idempotency |
| GET | `/app/digital-metals/documents/by-subject?docType=&subjectId=` | Latest artifact or `{ artifact: null }` |
| GET | `/app/digital-metals/documents/:artifactId` | Status |
| GET | `/app/digital-metals/documents/:artifactId/download-url` | Short-lived presigned URL (900s) |
| POST | `/app/digital-metals/documents/:artifactId/retry` | Re-queue failed generation |
| POST | `/admin/digital-metals/documents/request` | Same types; optional `customerId` for statements |
| GET | `/admin/digital-metals/documents/by-subject` | Admin poll |
| GET | `/admin/digital-metals/documents/:artifactId` | |
| GET | `/admin/digital-metals/documents/:artifactId/download-url` | |
| POST | `/admin/digital-metals/documents/:artifactId/retry` | |

Legacy `.pdf` GET routes redirect to presigned URL when a READY artifact exists; otherwise `DOCUMENT_NOT_REQUESTED` / `DOCUMENT_NOT_READY` (no synchronous PDF render).

`docType` values: `REDEMPTION_CHARGE_RECEIPT`, `HANDOVER_RECEIPT`, `SELL_ACKNOWLEDGEMENT`, `PAYOUT_RECEIPT`, `METAL_STATEMENT`.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/app/digital-metals/statements/metal?fromBusinessDate=&toBusinessDate=` | Journal-based opening/closing (IST) — JSON preview |
| GET | `/app/digital-metals/statements/metal.pdf` | Presigned redirect when READY statement artifact exists |
| GET | `/app/digital-metals/redemption/orders/:orderId/charge-receipt.pdf` | Charge only (not metal re-invoice) |
| GET | `/app/digital-metals/redemption/orders/:orderId/handover-receipt.pdf` | Completed handover |
| GET | `/app/digital-metals/sell-orders/:orderId/acknowledgement.pdf` | Post-execution sell |
| GET | `/admin/digital-metals/payouts/:payoutId/receipt.pdf` | Staff attested settlement |
| GET | `/admin/digital-metals/redemption/orders/:orderId/charge-receipt.pdf` | Admin charge receipt |

Purchase invoices: existing `/app|admin/.../buy-orders/:orderId/invoice` with outbox generation when credited (unchanged pipeline).

## 10. Error codes (additive)

| Code | HTTP | Meaning |
|------|------|---------|
| `DIGITAL_METALS_DISABLED` | 403 | Module off |
| `DIGITAL_METALS_PAUSED` | 403 | Operational pause |
| `STALE_RATE` | 409 | Rate too old |
| `TAX_CONFIG_INCOMPLETE` | 409 | Live trading blocked |
| `INSUFFICIENT_AVAILABLE_UG` | 409 | Wallet |
| `QUOTE_EXPIRED` | 409 | |
| `APPROVAL_REQUIRED` | 409 | Sell/payout |
| `PAYOUT_UNKNOWN` | 409 | Duplicate disbursement blocked |

## 11. Portals integration (Phase 1+)

| File | Change |
|------|--------|
| `src/store/api/admin-api.ts` | `digitalMetals` inject endpoints |
| `src/store/api/customer-api.ts` | `digitalMetals` inject endpoints |
| `src/store/api/platform-api.ts` | plan/tenant flags |
| `src/lib/portal-routes.ts` | `digital-metals` section |
| `src/lib/portal-nav.ts` | nav item gated on entitlement |
| `src/app/customer-router.tsx` | `digital-metals` section routes |
| `src/mocks/mock-server.ts` | contract-aligned mocks when added |

Customer deep links for notifications (Phase 10): `/customer/{slug}/digital-metals/...` (authenticated portal routes; never raw storage URLs).

### Transactional notifications (Phase 10)

| MessageType (additive) | Trigger (authoritative state) |
|------------------------|--------------------------------|
| `DIGITAL_METAL_PURCHASE_CREDITED` | Buy order `CREDITED` |
| `DIGITAL_METAL_PURCHASE_PAYMENT_FAILED` | Terminal payment failure / late-success review |
| `DIGITAL_METAL_SELL_EXECUTED` | Sell `PAYABLE_OPEN` (distinct from payout settled) |
| `DIGITAL_METAL_PAYOUT_UPDATE` | Payout `SETTLED` / `FAILED` / `UNKNOWN` |
| `DIGITAL_METAL_REDEMPTION_UPDATE` | Redemption `CHARGE_PAID`, fulfilment transitions (incl. **`REPLACEMENT_DISPATCHED`** per shipment event), `COMPLETED`, pre-dispatch `CANCELLED` |
| `DIGITAL_METAL_DOCUMENT_READY` | Document artifact `READY` |

Dedupe: `templateParams.inboxEventKey` = `digital_metal.{kind}:{entityId}:{transition?}` (delivery shipments append `:shipmentEventId` for `DISPATCHED` / `REPLACEMENT_DISPATCHED`). Outbox intent keys for those transitions use `{orderId}:{transition}:{shipmentEventId}`. Partial unique indexes on `(tenantId, reminderDedupeKey)` and `(tenantId, templateParams.inboxEventKey)` when string-typed. **Preview duplicates before index apply:** `node --env-file=.env scripts/detect-message-inbox-event-key-duplicates.js --dry-run` then `npm run db:sync-indexes:dry-run` → `npm run db:sync-indexes` (no production auto-apply from scripts).

**Resend:** Admin `POST …/messages/:messageId/resend` re-queues the **same** logical PUSH row when `reminderDedupeKey` / `inboxEventKey` is present (does not create a second Message or inbox entry). For PUSH, `prepareDeliveriesForLogicalResend` requeues exhausted **retryable** `PushDeviceDelivery` rows (`RETRYABLE_FAILED`, `DEAD_LETTER`, stale `PROCESSING`); **skips** `SUCCEEDED`, `PERMANENT_FAILED`, and active worker claims; caps `logicalResendCount` (`MESSAGE_LOGICAL_RESEND_MAX`, default 8). Outcomes: `RETRY_SCHEDULED` → `QUEUED`; `ALREADY_DELIVERED` → `SENT`; `NO_RETRY_TARGETS` / `NO_DEVICES` → `FAILED`; `ACTIVE_CLAIMS_ONLY` leaves status unchanged. Scheme/ecommerce/manual-push paths unchanged.

**Dispatch disposition (outbox):** On `PROCESSED`, persist `processedDisposition` ∈ `COMPLETED|SKIPPED|RETRYABLE|TERMINAL`, `processedOutcome`, and `processedSkipReason` when SKIPPED (`ALREADY_NOTIFIED`, `NO_DELIVERY_CHANNEL`, `SKIPPED_SUPERSEDED`, …). SKIPPED must not imply customer delivery in ops metrics.

**Intent repair:** Scheduler/dispatch runs `reconcileMissingDigitalMetalNotificationIntents` with **per-topic cursors** (not repeated oldest-25 scans). Completion markers on buy/sell/redemption rows when notice intent exists.

Outbox intent enqueued in the same Mongo transaction as the business transition where applicable; dispatch failures do not roll back business state.

### Operations visibility (Phase 10)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/admin/digital-metals/operations/work-queue` | Pending/failed/stuck outbox + documents; redacted errors |
| POST | `/admin/digital-metals/operations/outbox/:eventId/retry` | Re-queue notification/document outbox only |
| POST | `/admin/digital-metals/operations/documents/:artifactId/retry` | Same as document retry with audit |
| GET | `/platform/digital-metals/operations/summary` | Aggregate counts; optional `tenantId` filter |

## 12. contract-routes.lock

**Phase 0:** No new lines. Phase 1 adds capability/settings routes first; subsequent phases append atomically with `npm run check` route coverage script.
