# SwarnaGrow Digital Gold & Silver — implementation plan and Cursor prompts

Prepared 15 October 2026. Run the prompts in order, one phase at a time, in a Cursor workspace containing both repositories. These prompts are an implementation specification, not a claim that this module already exists or that the latest FCM patch has passed review.

## 1. Confirmed product decisions

- Each tenant jeweller is the seller, holds/manages the metal obligation, procures metal and fulfils requests. There is no external bullion-provider integration in the first release.
- Customer purchases are NOT limited by physical stock. Do not create bullion stock checks or stock reservations as prerequisites for buying.
- Customers have gold/silver wallets recording metal quantities, not a reloadable INR balance. Purchases are paid directly; sell proceeds become bank settlement payables.
- Customer metal reservations ARE required to prevent simultaneous sale/redemption of the same quantity. These are not physical-stock reservations.
- Provide physical redemption with branch pickup/home delivery and separate minting, packaging, delivery and applicable tax charges. Default: collect charges in INR through the gateway, not by deducting extra grams.
- Support tenant-configured same/separate buy/sell rates, optional platform/service fees and per-metal controls.
- Procurement and customer obligations feed the day-end hedge report. Procurement shortfall is reported, not used as an automatic purchase block. An explicit tenant pause or optional monetary exposure limit is separate.
- Gold, silver and different purities are separate assets. No automatic conversion, cross-tenant transfer or scheme balance transfer.

Implementation defaults proposed by this plan: manual tenant-wide rates; tenant-wide holdings with originating/service branch metadata; manual bank payouts with a second-person approval and settlement evidence; on-demand purchases rather than SIP/autopay; no storage deduction engine. These are defaults, not facts inferred from the current code. Future rate feeds/payout integrations should use adapters without pretending an integration is live.

Important commercial boundary: quantity credited before procurement is a recorded customer entitlement/obligation. It is not proof that specific physical bullion has already been allocated. Do not label it insured, allocated, independently vaulted, or regulator-protected without evidence. Final tax, custody, buyback and terms text require the merchant's approved business treatment. Do not hardcode legal KYC thresholds or invent regulatory claims.

## 2. Source grounding

The inspected archive hashes match the user's export:

| Repository | SHA-256 |
|---|---|
| Backend | `2f4cd05ef75a61007c882053458860dedd673849c409a04d4500fa123e4ddcb8` |
| Portals | `bd1a4ba776ddc00fd0758ff3054f686a42869261027cdb60a50e6dacb89e2747` |

The frontend package is `swarnagrow-portals`: one Next/React/TypeScript application contains platform, tenant admin, agent and customer surfaces. Do not create a second frontend application.

Existing anchors, relative to their repository roots:

| Concern | Existing files/patterns to inspect and extend |
|---|---|
| Entitlements | Backend `src/constants/plan-features.js`, `src/lib/feature-entitlements.js`, `src/models/identity.models.js`, platform validators/services |
| Platform API | Backend `src/routes/platform.routes.js`; frontend `src/store/api/platform-api.ts`, `src/features/platform/` |
| Tenant API | Frontend `src/store/api/admin-api.ts`; backend route/controller/service conventions |
| Customer API | Frontend `src/store/api/customer-api.ts`, `src/app/customer-router.tsx`, `src/features/customer/` |
| Routing/navigation | Frontend `src/app/portal-router.tsx`, `src/lib/portal-routes.ts`, `src/lib/portal-nav.ts`, existing shells and permission catalog |
| Payments | Backend `src/integrations/phonepe.provider.js`, `src/routes/webhook.routes.js`, existing webhook identity/tenant guards and payment reconciliation |
| Accounting | Backend `src/models/scheme.models.js`: existing `LedgerEntry` requires `schemeId`; create dedicated digital-metal accounting |
| Fulfilment | Existing ecommerce quote/payment/order/fulfilment/handover utilities; reuse safe shared utilities, not stock-gated order semantics |
| Reliability | Existing transaction, idempotency, outbox, worker/scheduler, exact-money, audit and message infrastructure |
| Contracts | Backend `docs/contract-routes.lock` and existing contract documentation; frontend contract adapters and mocks |

Backend remains JavaScript/Express/Mongoose; frontend remains TypeScript. No new framework, database, microservice, Docker requirement or blockchain.

## 3. Product surfaces

| Surface | Pages and actions |
|---|---|
| Platform | Subscription entitlement, per-tenant module availability, operational pause, tenant capability/usage, payment readiness and exception metrics |
| Tenant admin | Overview, settings/fees/taxes, rates, customer wallets, purchase orders, sell orders, payouts, redemption catalogue, redemption fulfilment, procurement, hedge reports, reconciliation and audit |
| Customer | Digital metals home, portfolio, buy, purchase result, sell, bank destination, sale/payout detail, coin/bar redemption catalogue, charge checkout, delivery/pickup tracking, passbook/statements and terms |

Proposed backend paths: `/admin/digital-metals/*`, `/app/digital-metals/*`, and appropriate existing `/platform/tenants/:tenantId/*` configuration routes. Proposed frontend paths: tenant `/digital-metals/*`, customer under the actual existing customer prefix, platform inside existing tenant/plan screens. Phase 0 must resolve actual prefixes; do not guess `/customer` if routing uses another prefix.

## 4. Accounting and execution contract

### Accounts and precision

- Proposed asset identity: tenant + customer + metal (`GOLD`/`SILVER`) + purity/fineness. Store precise fineness, not merely a `24K` label.
- Use integer micrograms (`quantityUg`, 1 g = 1,000,000 ug) for new metal accounting, paise for money, decimal.js for calculations, and explicit safe-integer bounds. Existing scheme milligrams stay unchanged. Serialize large values as decimal strings if required by the chosen bounded representation; never introduce unbounded JS Number arithmetic.
- Wallet: total held entitlement, reserved quantity, available = held minus reserved; pending purchases shown separately and excluded from spendable holdings.
- Immutable quantity journal, INR order/payable journal and reservation movements must balance within each unit. Do not add grams and rupees into one balance. Customer balances are transactionally maintained projections rebuildable from the journals.
- Maintain acquisition lots for any holding-period eligibility. Reservation/allocation must select eligible lots consistently, including concurrent requests and partial sales. No average purchase date shortcut.

### Rates, quotes and fees

Use explicit customer-perspective fields `customerBuyRatePerGramPaise` and `customerSellRatePerGramPaise`. Preserve immutable rate versions, effective timestamps, source and maximum age. Scheme/ecommerce rates may be references only through explicit configuration, never implicit fallback; neither current scheme 22K rules nor ecommerce checkout should change.

Buy/sell/charge quotes snapshot asset, rate, calculation version, quantity, fee components, tax components, total/net settlement, settings version, terms version and expiry. Published setting/rate changes do not rewrite an accepted order. Expiry and payment-settlement policy must be explicit.

Fee choices: none, flat INR, percentage, percentage with min/max; independent buy/sell fee rules. Minting can be a denomination price, per-gram charge or percentage of a documented base. Delivery may be flat, zone/weight based or free above a documented threshold. Define fee stacking, rounding, tax bases and whether a rupee input is total budget or metal subtotal; default customer rupee input = total payable budget. Do not treat tax as a freely removable service fee. Require approved tax configuration before taking live orders.

### Buy

Accepted quote -> purchase order/payment attempt -> verified payment -> atomic journal/holding credit -> invoice/outbox. No stock check. Define a finite payment acceptance window. The first release should honour only its frozen accepted-price policy within that window; late/uncertain successes move to explicit refund/review handling, never silent re-pricing or fewer grams. Duplicates credit once. Refund/chargeback after metal is spent becomes an exception/debt/freeze workflow; do not create impossible negative available holdings.

### Sell

Quote -> atomic eligible-wallet reservation -> customer confirmation/required approval -> executed sale debits metal and creates fixed INR payable -> payout attempts -> reconciled settlement. Before execution, cancellation releases the reservation. After execution, payout failure leaves the INR payable outstanding; it does not automatically restore metal. Unknown bank outcome blocks duplicate payout. Rate lock/approval expiry must be explicit so pending approvals do not grant unlimited free price optionality.

### Physical redemption

Quote denomination/charges -> atomic wallet reservation -> charge payment -> fulfilment accepted -> packing/dispatch or pickup-ready -> proof of handover/delivery -> final quantity consumption. Keep entitlement and allocated-to-fulfilment quantity identifiable until the specified accounting handover event. RTO/loss/damage need explicit exception states; holdings are not released merely because shipping failed. Restore entitlement only via controlled cancellation/verified return and reversal entries. No physical stock prerequisite; catalogue listing can mean available to order, with lead time disclosed.

### Hedge report

Report per tenant/metal/purity and IST business day using immutable event times and deterministic cutoffs:

`closing obligation = opening obligation + completed customer buys - executed sell-backs - completed physical handovers +/- obligation adjustments`

`closing hedge position = opening position + executed procurement - supplier disposals - completed physical handovers +/- hedge adjustments`

`uncovered position = closing obligation - closing hedge position`

These are consistent perimeter definitions, not a universal accounting standard. Phase 0/8 must document location/custody and physical-pickup treatment. Buying from a customer reduces customer obligation; it does not create new physical metal entering a vault. Reserving, paying a minting charge, or requesting delivery changes neither equation. Dispatch/in-transit is shown separately; do not remove metal from coverage and retain the obligation in inconsistent perimeters. Show firm purchase commitments separately from received bullion. Distinguish provisional live reports, versioned day-end snapshots, subsequent adjustments and signed opening balances. Without an opening hedge position, report exposure as incomplete, not zero.

## 5. Phase map

| Phase | Deliverable |
|---|---|
| 0 | Repository baseline, fixed contract and acceptance examples |
| 1 | Entitlements, permissions, platform controls and route shells |
| 2 | Rates, commercial settings, exact quote engine and admin UI |
| 3 | Wallet ledger, lots, reservations and read APIs |
| 4 | Buying, verified payments, invoices and customer/admin UI |
| 5 | Selling, bank destinations, manual payouts and UI |
| 6 | Redemption catalogue, minting/delivery quotes and charge payments |
| 7 | Physical fulfilment, pickup, tracking, return/exception handling |
| 8 | Procurement journal and day-end hedge reporting |
| 9 | Complete platform/admin/customer workspace and statements |
| 10 | Transactional notifications and operational recovery |
| 11 | Concurrency, integration/browser tests and release preparation |

Each phase includes meaningful tests and the UI needed for its scope. Phase 9 closes cross-surface gaps; it is not permission to leave earlier phases as backend-only placeholders.

## 6. Master instructions — paste once before Phase 0

```text
Implement SwarnaGrow Digital Gold & Silver using the accompanying playbook. Work in the existing backend and portals repositories. Read repository instructions first and inspect current code before choosing integration points. Preserve all current uncommitted changes; never reset, stash, delete or overwrite unrelated work.

Confirmed model: each tenant jeweller sells/manages metal and procures based on hedge reporting. Purchases MUST NOT require physical stock availability. Reserve customer wallet quantities only to prevent double spending. Provide gold/silver accounts, buy/sell, bank settlements, physical redemption, minting/delivery charges and hedge reports. No cash-wallet topups, P2P, cross-tenant transfers or implicit scheme transfers.

Use existing JS backend, TS portals, authentication, tenant/branch rules, exact arithmetic, transaction/idempotency patterns, audit, outbox, workers/scheduler and gateway integration. Create digital-metal domain records; do not overload schemeId-required ledger/payment records or route this through stock-gated ecommerce checkout. Extend shared gateway dispatch safely and keep old routes working.

Read docs/DIGITAL_METALS_SPEC.md and docs/DIGITAL_METALS_PROGRESS.md at the start of every phase once created. Implement ONLY the requested phase and necessary prerequisites. Keep operation availability server-authoritative. Plan expiry/module disable must not prevent viewing existing holdings or completing refunds/payouts/fulfilment; operational suspension policy is distinct from sales entitlement. Fraud/safety holds need explicit states.

Every monetary/metal mutation must have tenant ownership checks, permission checks, concurrency control, durable idempotency, exact arithmetic and audit evidence. Do not perform network calls inside Mongo transactions. No raw bank details or tokens in logs/notifications. Use compensating entries rather than rewriting journals.

Use real API integration and repository contract wrappers in UI. Do not claim a gateway, bank-verification service, payout provider or courier integration exists when it does not. Manual operations must be labelled and evidenced. No live financial transactions or production index writes.

For each phase: implement, run focused tests and required checks, update contract/routes/mocks/docs and progress log, then report exact pass/fail/blocked results and changed files. Do not weaken tests to pass. Distinguish unit, Mongo, Redis, browser and real-device evidence. Do not push or deploy. Stop after the phase with a reviewable result.
```

## Phase 0 — inspect, baseline and freeze the contract

```text
Execute Phase 0 only. Inspect both repositories, git status, instructions, existing platform/tenant/customer routing, subscription entitlements, role scopes, payment/webhook routing, refunds, transactions, journals, branch rules, workers/outbox, fulfilment and API envelopes.

Create backend docs/DIGITAL_METALS_SPEC.md, docs/DIGITAL_METALS_API_CONTRACT.md and docs/DIGITAL_METALS_PROGRESS.md. Mirror/link the relevant contract in portals using the existing docs convention. Record actual integration files, proposed schemas/indexes, API paths, DTOs, permission matrix, operation-state transitions and failure/recovery ownership.

Freeze microgram/paise precision and bounds, fee/tax calculation order, all-in buy budget semantics, accepted-quote payment windows, sell approval/rate-lock expiry, acquisition-lot holding rules, wallet reservation behavior, physical handover accounting, opening hedge balance and report cutoffs. Give numerical acceptance examples for no-fee/same-rate, spread, percentage+minimum fee, small fractional buys, sell payout failure, 2g redemption from 5g and a hedge day with buys/sells/handovers.

Tax rules must be configurable and approved rather than assumed. Mark live readiness blocked where approval is absent. Select manual payout with second-person approval/evidence for v1, and explain verification limits. Record customer-entitlement wording for procurement-after-sale; do not promise physically allocated/insured bullion.

Run reasonable existing baseline checks, record pre-existing failures distinctly and define targeted regression commands. Review the latest uncommitted promotion changes as dependencies without rewriting them. Do not declare the whole old module verified. This phase creates specification/tests of pure acceptance examples only; no live trading routes.
```

## Phase 1 — entitlements, permission boundaries and platform controls

```text
Execute Phase 1. Add an explicit digitalMetals plan entitlement, tenant enablement and server capability DTO using existing plan snapshot/override conventions. Default all existing tenants/plans to disabled. Keep module availability independent from ecommerceEnabled/ecommercePayments and scheme settings.

Define explicit operation capability checks: new buy/sell/redemption requests versus access to existing holdings, outstanding payables, refunds and fulfilment. Define operator pauses with reason/audit. No subscription downgrade may delete or strand obligations. Continue authenticated status and settlement/recovery paths when new trading is disabled. Emergency risk controls may pause specific money movement without hiding history.

Add granular permissions for read, settings/rates, sell approval, payout approval/recording, redemption fulfilment, procurement/reporting and adjustments. Preserve branch-scoped restrictions; tenant ownership must be checked for every identifier. Platform users configure entitlement and inspect permitted health data, not silently modify customer balances.

Wire platform plan/tenant switches through validators/services/DTOs and platform-api.ts plus existing platform pages. Add tenant Digital Metals navigation and placeholder-disabled workspace, customer capability-driven entry and deep-route guards in the existing routers/shells. Unknown roles/flags fail closed. No blank pages or fake balances.

Tests: entitlement denied/enabled, tenant override, direct API denial, cross-tenant ID, branch restrictions, hidden navigation versus server authority, downgrade with existing holdings and backward-compatible feature normalization. Update route lock, contracts and progress log. No buy execution yet.
```

## Phase 2 — settings, rates and exact quote calculations

```text
Execute Phase 2. Implement tenant/asset settings and immutable effective-dated digital-metal rates, explicit customerBuy/customerSell rate names, manual publishing, maximum age/stale checks, future effective timestamps and version conflicts. No automatic sharing with scheme or ecommerce rates; changes to those modules must not alter digital trades.

Implement the frozen exact-arithmetic quote engine for rupee-budget or quantity input. Support same/separate rates, no/flat/percentage/min-max buy and sell fees, inclusive/exclusive display and independently itemized approved taxes. Quotes include expiry, asset/rate/settings/terms/calculation versions and immutable amount snapshots. Reject invalid/unsafe ranges, nonpositive net amounts and impossible rounding; expose any budget remainder explicitly. Implement an optional configured exposure guard separately from physical stock; leave it off by default.

Build tenant settings/rate pages, quote preview and RTK integration. Dates round-trip local-input/UTC correctly. Display customer Buy/Sell perspective clearly. Add backend capability reasons for missing/stale rates and incomplete tax configuration. Store old settings versions; editing fees does not rewrite accepted orders.

Tests: all Phase 0 numerical examples, fractional boundary, exact same-rate case with fees/taxes, fee min/max, buy-budget inversion, rounding, invalid schedules, stale rate, concurrent rate publishing and tenant isolation. No physical inventory query in the quote path. Update docs/route lock/mocks and progress.
```

## Phase 3 — metal accounts, immutable journals and reservations

```text
Execute Phase 3. Create dedicated digital-metal accounts, immutable unit-specific balanced journal events, acquisition lots and reservations. Follow the spec's microgram bounds. Do not reuse the schemeId-required LedgerEntry or create a reusable INR customer wallet.

Account identity is tenant/customer/metal/purity. Maintain projections and monotonic sequences transactionally; provide rebuild/reconciliation logic. Holdings available = held minus live reserved quantity; unpaid orders do not contribute. Track acquisition lots and eligible quantity for any holding period. Reservation states must distinguish cancellable pre-execution holds from executed sale or in-progress physical fulfilment.

Provide internal posting/reserve/commit/release/reversal services and authenticated customer/admin wallet and passbook reads with cursor pagination. There is no general public credit-wallet endpoint. Administrative opening/import/adjustment is disabled unless implemented as audited, approved balanced journals with provenance and idempotency.

Wire customer portfolio and tenant customer-wallet read views using actual responses. Empty state is no transactions, not synthetic holdings. Show gold/silver and purity separately; include reservation explanation and versioned quantity formatting.

Tests: reserve 4g twice concurrently from 5g permits only one; sell-versus-redeem races; lot holding eligibility, partial release, duplicate posting, rollback, reversal, projection rebuild, cross-tenant/branch access and upper bounds. No bullion stock reservations. Record test evidence and progress.
```

## Phase 4 — buying and payment finalization end to end

```text
Execute Phase 4. Implement buy quote acceptance, immutable purchase order, payment attempts, expiration, verified finalization and purchase invoice. No stock lookup/block/reservation. Reuse tenant PhonePe credentials/provider transport and webhook security, adding explicit digital-metal domain dispatch without breaking scheme/ecommerce merchant-order routing or refunds.

Persist order/payment intent before external calls; use leases/idempotency for initiation. Verified webhook or provider poll must atomically finalize once: purchase journal, lot/holding credit, order success and outbox event. Browser redirect is not proof of payment. Preserve tenant/amount/currency/provider identity validation and reject mismatches.

Implement the Phase 0 accepted-price/payment-window policy and late-success handling. Unknown outcomes stay reconcilable. A paid-but-credit transaction failure retries safely. Expired payment later succeeding does not silently reprice, double credit or disappear; use refund/review workflow with evidence. Refund/chargeback after metal has been spent needs explicit exposure handling, not a negative available balance.

Build customer Buy, review, gateway redirect/result/polling and purchase detail; tenant purchase list/detail, exceptions and invoice actions. Resume safely after refresh. Generate invoice snapshots asynchronously/idempotently without turning a committed purchase into a false API failure.

Tests: full valid buy with no physical stock, duplicate webhook/poll race, spoofed/other-tenant callback, wrong amount, late success, provider timeout, DB rollback, outbox failure and browser refresh/double-submit. Update docs, mocks and regression evidence.
```

## Phase 5 — sales, bank destinations and manual payouts

```text
Execute Phase 5. Implement sell quotes, customer confirmation, eligible-lot reservation, explicit approval/expiry, execution and INR payable creation. Honor quote/approval price-lock rules from the spec; do not hold a customer to a silently changed rate. Repeated submissions execute once.

Implement tenant-scoped customer bank destinations with masked DTOs, protected storage and approval/verification state. Do not call manual staff verification automated bank verification. Freeze destination details on the payout; a later account change cannot redirect an existing payable. Add suitable step-up/reconfirmation for sensitive changes using existing auth patterns.

V1 payout is manual: maker records payout instruction/evidence, a different authorized user approves the controlled action; record bank reference, actual settlement date, amount and evidence. A reference string alone is not authoritative proof of bank receipt. Define pending/submitted/unknown/failed/settled states and reconciliation. Unknown result blocks another disbursement. Execution debits metal and creates fixed INR liability; payout failure keeps that liability. Never auto-restore metal after sale execution. Manual corrective reversal requires evidence/approval.

Build customer sell/bank setup/status views and tenant sales/payout queue/detail/approvals. Separate 'sale completed' from 'bank payout settled'. Show outstanding/overdue payables.

Tests: sell/redeem concurrency, insufficient eligible quantity, cancellation before execution, approval expiry, same-user approval blocked, failure/unknown payout, duplicate reference policy, destination change, retry settlement and cross-tenant bank data access. No money topups or cross-customer transfer.
```

## Phase 6 — redemption catalogue, minting/delivery charges and checkout

```text
Execute Phase 6. Build a dedicated redemption catalogue for gold/silver coins/bars with exact purity, denomination quantity, images through existing upload auth, active state, lead time, pickup/delivery capability and charge rules. This is available-to-order merchandising, not stock-controlled checkout.

Support denomination minting fees, per-gram/percentage alternatives with explicit base, optional packaging, delivery zone/weight/flat rules, fee waiver criteria and separately itemized approved taxes. Publish immutable catalogue/charge versions. Validate address/serviceability and selected pickup branch on the server. No COD; collect charges directly in INR. Do not deduct extra grams for charges.

Create redemption quote and atomic wallet reservation with pending charge order/payment attempt, expiry and accepted-price snapshots. Reuse the digital payment machinery with explicit charge-order purpose; charge payment must never credit new metal. Zero-charge redemption follows a fully authorized no-payment path without a fake gateway success.

Build tenant catalogue/charge editor; customer denomination selection, address/pickup, charge review and payment/status UI. Explain exactly quantity reserved, quantity remaining and delivery estimate. Catalogue/rate changes must not rewrite accepted requests.

Tests: 2g redemption from 5g reserves exactly 2g; concurrent sell; disabled item; incompatible purity; serviceability; fee rounding/waiver; zero-charge path; duplicate webhook; expired reservation followed by late charge success handled through explicit review/refund without fulfilling unreserved grams. Update contracts and evidence.
```

## Phase 7 — fulfilment, handover and exceptions

```text
Execute Phase 7. Implement approved redemption -> charge-ready/paid -> fulfilment acceptance -> packing -> dispatched or pickup-ready -> completed handover/delivery. Use operation-level permissions, version checks, immutable events and idempotency. No physical stock gate, but disclose procurement/production lead time and allow an evidenced delay state.

Reuse suitable pickup-code, address, shipment presentation and invoice utilities after inspecting their coupling. Do not silently create stock-gated ecommerce orders. Manual courier tracking must be labelled manual; do not invent live carrier status. Pickup proof uses hashed/expiring challenge, attempt limits and authorized branch handover.

On completed handover consume the reserved entitlement exactly once and record the matching physical-out hedge event under the agreed accounting perimeter. Dispatch alone must not erase the obligation. Track in-transit quantity separately. Support pre-dispatch cancellation with reservation release and charge-refund policy. After dispatch, RTO/damage/loss goes to explicit investigation; release/restore only after verified return/controlled resolution. Unknown courier events cannot release spendable holdings.

Build tenant fulfilment queue, packing/dispatch/pickup actions, evidence, exceptions and customer progress/tracking. Generate appropriate immutable handover/charge documents; do not double invoice previously purchased metal or assume tax treatment without the configured policy.

Tests: double handover, wrong branch/code, concurrent completion/cancellation, RTO, lost parcel, partial/unsupported return rejection, duplicate carrier/manual event, paid charges but fulfilment failure and exactly-once wallet/hedge movements.
```

## Phase 8 — procurement and day-end hedge report

```text
Execute Phase 8. Add an immutable tenant/metal/purity procurement/hedge journal with approved opening positions, supplier purchases, executed commitments, receipts, supplier disposals and reversals. Track commitment and physical receipt separately and do not double count them. Evidence includes supplier/bill/date/location/quantity, enteredBy/approvedBy and idempotency. Do not turn procurement into a customer buying prerequisite.

Implement the obligation/hedge equations and perimeter in DIGITAL_METALS_SPEC. Customer sell-back reduces obligation, not physical bullion inflow. A request/reservation or minting payment changes no customer obligation/hedge total. Completed physical handover reduces both once. Exclude failed/pending buys; do not delay sale quantity accounting until bank payout. Include in-transit, overdue fulfilment and unpaid INR payables as separate measures.

Build live provisional and versioned IST day-end snapshots with cutoff event cursor/high-water mark. Backdated entries and corrections produce controlled revised snapshots/adjustments rather than silent historical rewrites. Reports must state incomplete opening data. Use cursor pagination/indexes and existing report/export jobs; protect CSV formula injection.

Tenant UI: procurement entry/approval, hedge dashboard by asset, day-end close/export and reconciliation drilldown to source events. Platform may see authorized health/aggregate exceptions without exposing private bank data.

Tests: opening+buys+sells+procurement+handover example, zero physical stock purchases still allowed, double-count prevention, mixed purities, midnight cutoff, duplicate events, backdated correction, missing opening data, repeated snapshot generation and large paginated history.
```

## Phase 9 — complete portal workspaces and statements

```text
Execute Phase 9. Audit and complete all three existing portal surfaces using real backend contracts; do not rebuild completed phase UI or create another app.

Platform: plan entitlement, per-tenant controls/capability blockers, operational status, module usage and outstanding exception health. Tenant: consolidated overview/settings/rates/wallets/buys/sells/payouts/catalogue/fulfilment/procurement/hedge/reconciliation/audit with useful filters, pagination, drilldowns and branch scope. Customer: mobile-first portfolio, buy/sell/redeem, bank setup, passbook, documents and status histories under the actual CustomerRouter prefix.

Portfolio valuation uses current valid sell quote/rate with labels and fee assumptions; unavailable rate shows unavailable valuation without hiding grams. Distinguish holding cost, estimated value, confirmed metal and pending purchase. Do not imply guaranteed profit. Expose per-purity assets and reservations clearly.

Add downloadable date-range statements with opening/closing holdings, activity, reserved/available balances and sale settlement statuses using read-time snapshots and existing PDF/export patterns. Include relevant charge invoices and receipts under authorized URLs. Show tenant-approved terms/custody/procurement model, seller and accepted terms version.

Cover loading/empty/error/disabled/stale-rate/paused states, accessibility, refresh persistence and real contract error shapes. Client-calculated previews never authorize transactions. Update mocks and route/nav/permission tests. Run frontend typecheck, focused component tests and build; report unrelated lint failures separately.
```

## Phase 10 — notifications, recovery and operational visibility

```text
Execute Phase 10. Use the existing durable Message/outbox/worker infrastructure for transactional events: buy credited, sale executed, payout settled/failed, charge payment, redemption accepted, dispatched, pickup-ready, completed and actionable exceptions. Customer holdings and committed orders must succeed even when Redis/FCM is unavailable.

Persist notification intent with the business transaction, enqueue after commit safely and recover through maintenance. Dedupe per tenant/customer/business event, not globally per message type. Use distinct digital-metal metadata/deep links that route correctly in the customer portal; never include bank details, secret pickup codes or private KYC data in generic push payloads. Separate optional marketing/rate announcements from transactional events and their permissions/consent.

Audit all new recovery workers: finite leases, owner-fenced atomic state transitions, retries versus terminal exceptions, indexes, bounded progressing scans and delayed due-time continuations. Combine multiple $or conditions with $and. No scan may repeatedly select an already-completed oldest batch forever. Recover interrupted payment finalization, invoice/export generation, expired pre-execution reservations, payout unknowns and notifications. Never expire a post-execution payable or an in-transit physical entitlement as an ordinary abandoned reservation.

Add platform/tenant monitoring for stuck operations and reconciliation discrepancies with safe redacted logs. Tests include lost lease, crash after durable write, Redis unavailable then restored, job retention/dedupe, duplicate event, delayed scheduling and per-event inbox dedupe. Mark real-device FCM verification as a separate manual gate.
```

## Phase 11 — final verification and rollout pack

```text
Execute Phase 11. Inspect the completed digital-metal changes against DIGITAL_METALS_SPEC and prior phase evidence. Fix integration defects within scope. No production deploy/push or live financial transaction.

Run full applicable backend checks and regression suites covering existing scheme/ecommerce/gateway/promotion paths. Run digital-metal Mongo transaction/concurrency tests and real Redis/BullMQ integration tests. Run portals tests, typecheck and production build; changed-area lint and overall lint status must be honest. Use repository supported runners rather than guessing npm flags that change which tests execute.

Browser scenarios across platform/admin/customer: entitlement enable; rate+fee publish; buy; refresh during payment; duplicated callback; sell approval; manual payout unknown/settled; 2g coin redemption from 5g; minting+delivery charge; pickup and home-delivery exception; hedge close/export; downgrade with existing obligations; branch and cross-tenant denial. Add actual request/response contract checks and quote-expiry concurrency tests. Use deterministic fake clock alongside a real-time delayed-job test; do not confuse them.

Create docs/DIGITAL_METALS_RELEASE_CHECKLIST.md with exact evidence, blocked checks, manual merchant tax/terms/payment-use readiness, opening-position import policy and operational runbooks. Index preview uses diffIndexes only with autoCreate/autoIndex disabled; explicit apply is separate and not executed here. Provide code-before-traffic/index-compatible rollout and API/worker/scheduler restart instructions. Rollback must stop new trades while retaining settlement access and all immutable journals; never drop customer records.

Update progress with each requirement's implemented/tested/blocked status. Do not declare production ready from unit tests. Identify any unavailable bank verification/payout/courier integration plainly. Native FCM and actual provider staging acceptance require separate evidence.
```

## 7. Optional later scope — do not silently add during core phases

- Jewellery exchange: explicit quote and settlement against an invoice, metal/purity conversion rules, taxes/charges, partial payment, cancellation and exactly-once wallet debit. This needs a dedicated acceptance contract before implementation.
- Automated bank payouts: provider contract, onboarding, beneficiary verification, tenant funding, signed callbacks and unknown-outcome reconciliation. Manual payout UI is not an API integration.
- Live rate feed: data rights, source freshness, tenant markup, failover and circuit breaker; never reprice accepted orders.
- Branch price overrides: explicit originating-rate and fulfilment branch semantics; no silent cross-branch arbitrage.
- SIP/autopay, gifts/transfers, storage fees or metal-funded charges: separate approved scope and ledger/failure policies. No cash wallet is included.

## 8. Review protocol after each prompt

Ask Cursor for changed files, behavioral examples, exact commands/results, remaining blockers and a focused diff. Review before moving to the next phase. Preserve work locally; do not package only HEAD while omitting uncommitted implementation. Keep the phase log in the repositories so a new Cursor session can continue without inventing prior decisions.

An implementation is not accepted merely because a summary says complete. Payment, metal and payout accounting must reconcile under retries, concurrency and crashes, and all three portal surfaces must use the real contract.
