# SwarnaGrow remediation candidate — 2026-11-03

All nineteen requested correction areas have implementation changes in this candidate.
**This is NOT a production sign-off.** Real Mongo integration/release verification is blocked
in this environment: mongod fails before tests with `open: Operation not permitted` / exit100.
Do not describe model-double tests as Mongo concurrency/rollback proof.

Original uploaded source ZIPs remain untouched. No deployment, data migration, provider payment,
WhatsApp feature restoration, maker/checker workflow or new branch restrictions were performed.
The earlier auto-accept changes were merged into the uploaded baseline, followed by focused audit
corrections. Graphify was unavailable here; dependencies/callers were traced through source.

## Correction map

| ID | Area | Implementation | Regression / release evidence |
|---|---|---|---|
| R01 | Digital-metal sell | Counter reservation/debit/payable/notice share one transaction. Committed retry precedes mutable quote/bank/risk checks; UI defaults to payment pending. Files: `src/services/digital-metals-sell.service.js; src/services/digital-metals-assisted.service.js` | digital-metals-auto-accept-replay.unit.test.js; digital-metals-auto-accept.test.js; counter-trades.test.js |
| R02 | Sell payment state | Replay and customer history hydrate current payable and in-flight payout status. Files: `src/services/digital-metals-sell.service.js; src/services/digital-metals-customer-orders.service.js` | auto-accept replay unit tests; nov03 audit R02 history test |
| R03 | Legacy reservations | Never infer an unmarked accounting convention from allocation presence. Reviewed legacy release leaves lots untouched; commit claims lots. Preflight blocks rollout for unclassified records. Files: `src/services/digital-metals-ledger.service.js; scripts/migrate-financial-invariants.js` | nov03 audit R03 unit cases; staging legacy reconciliation required |
| R05 | Counter cash | Bind replay to persisted mode/reference/operator. Post cash in successful payment transaction; repeated source repairs idempotently. Files: `src/lib/counter-tender.js; digital-metals-buy-finalize.service.js; ecommerce-payment-finalize.service.js` | nov03 R05 units; counter-trades cash-failure rollback integration tests |
| R06 | Reservation expiry | Bounded rotating scheduled sell/redemption sweep; accepted unpaid sells excluded; uncertain charge attempts deferred; initiation and expiry serialize on order version. Files: `src/services/digital-metals-reservation-expiry.service.js; src/schedulers/repeatable-jobs.js; src/workers/processors.js` | nov03 expiry units; auto-accept R06 integration batch test; Redis worker staging check required |
| R07 | Delivery evidence | Copy validated evidence/attestation onto the locked document saved in the transaction. Files: `src/services/digital-metals-redemption-fulfilment.service.js` | nov03 R07 unit; phase7 matrix reload assertions |
| R08 | Pickup fencing | Atomic code reissue checks version/status; handover fences version/hash/expiry/attempts inside transaction. Wrong attempts increment atomically without overwriting newer code. Files: `src/services/digital-metals-redemption-fulfilment.service.js` | nov03 R08 interleave unit; phase7 matrix controlled HTTP reissue integration |
| R09 | Refund overlap | Provider and manual share one atomic case claim. Manual blocks initiated/pending/unknown and completed states. Verified FAILED remains eligible. Online manual returns settle the shared case and record its ID for totals. Files: `src/lib/ecommerce-manual-refund.js; src/services/ecommerce-order-return.service.js; ecommerce-payment-exception-refund.service.js` | nov03 R09 units; return-inspection pending-provider integration |
| R10 | Restock entitlement | Original-order restock marker/version fence plus legacy request check prevents cross-request restock; resolved full returns/exchanges cannot create a second full return. Files: `src/lib/ecommerce-order-stock-restock.js; src/models/ecommerce-commerce.models.js` | nov03 R10 unit; existing return inspection integration bundle |
| R11 | Return closure | RETURN resolution requires recorded manual repayment or terminal shared refund. Existing exchange replacement/manual-settlement paths retained. Files: `src/services/ecommerce-order-return.service.js` | nov03 R11 unit; return inspection integration bundle |
| R13 | Pickup recovery UI | Wire existing pickup-code endpoint to Reissue pickup code; block expired/locked collection and refresh order/version after reissue. Files: `frontend ecommerce-pickup-collection-panel.tsx; ecommerce-order-detail-page.tsx; admin-api.ts` | pickup panel reissue test included in 213 frontend tests |
| R14 | Customer refund totals | Include manual returns and COD cancellation proofs; new shared-case manual returns are not counted twice. Historical unlinked proofs stay visible as actual recorded outflows. Files: `src/services/ecommerce-admin-customer-orders.service.js` | nov03 R14 aggregate-service unit |
| R15 | Scheme eligibility | Maturity and both defaulting paths fence selected tenant/status/version and financial position version where present. Files: `src/services/scheme-maintenance.service.js` | nov03 R15 maturity and defaulting units |
| R16 | Maturity notice | Status transition, push inbox intent and associated audit use one Mongo session/transaction; no nested notification transaction. Files: `src/services/scheme-maintenance.service.js; src/services/customer-notification.service.js` | nov03 R16 shared-session/failure unit; real Mongo rollback pending |
| R17 | Enrolment replay | Deterministic durable operation identity/body hash/result commits with enrolment/collect-now. Admin/staff and customer checkout recover after HTTP cache loss; new keys allow legitimate additional schemes. Files: `src/lib/enrolment-operation.js; src/models/enrolment-operation.model.js; src/services/scheme.service.js` | nov03 R17 unit; enrolment-phase2 admin collection replay integration; customer checkout resume suite |
| R18 | Idempotency namespace | Mounted current API namespaces stay distinct; legacy unmounted same-resource compatibility remains. Files: `src/lib/idempotency-endpoint.js` | nov03 R18 unit; existing idempotency integration suite |
| R20 | OTP length | Public resolver exposes verified non-secret delivery length; context forwards it; unverified/mock defaults six. Validation uses the length stored with delivered OTP. Files: `src/lib/customer-app-dto.js; src/services/customer-app.service.js; src/integrations/otp.provider.js; frontend customer-tenant-context.tsx` | nov03 R20 DTO/provider units; customer OTP public resolver integration; frontend helper tests |
| R21 | Phone normalization | India-only configuration and strict Indian national-number validation; reject unsupported country/length without truncating. Files: `src/integrations/message-central.client.js; src/validators/platform.validators.js` | nov03 R21 unit |
| R23 | Release/export | Remove lint failures; preserve runner status through logging; default explicit test glob; portable optional preview support; export works without Git and omits deleted paths; frontend uses its supplied pnpm lock. Files: `scripts/run-test-release.sh; scripts/package-source-export.mjs; frontend vite.config.ts` | lint/typecheck/tests/build; export identity checks; simulated runner exit7 propagates |

## Existing corrected areas preserved

R04 release errors propagate. R12 executable filters remain separate from cursor identity.
R19 platform Message Central credentials support tenantless signup. R22 requires completed
provider verification status. These were not replaced with the older implementations.

## Verification boundary

Frontend full tests: 213 passing; lint/typecheck/build pass with existing local dependency installation.
Backend focused pure audit checks: see bundled final log for totals. Backend syntax, route coverage
and outbox session checks pass; lint is checked again after final edits. No clean dependency install
or full backend release pass is claimed. Preinstalled dependencies were reused by symlink for checks.
New DB regressions are included but cannot execute here. A targeted R17 Mongo attempt fails in
setup, not in its application assertion. Runner logging was probed with a simulated Node exit7,
which propagated as wrapper exit7; this is a shell behavior test, not a release-suite run.

## Run on the release machine

Extract into NEW sibling directories. Do not overwrite a newer worktree or discard uncommitted work.
Use the supplied change manifest/patch to compare with any already-fixed candidate on the Mac.

Backend (Node >=22, existing project lockfile):

```bash
npm ci
npm run check
npm run test:audit:unit
npm run test:audit:integration
```

Fix any real integration failure before running the full gate. Do not weaken assertions or add
blanket retries. Then freeze the source and run one authoritative full release:

```bash
RELEASE_LOG=/tmp/swarna-remediated-candidate-release.log npm run test:release
```

Require actual exit0, fail0, cancelled0 and explicitly explained skips, with the same source
fingerprint before/after. The test runner now sets RUN_HEAVY=1 and expands the default test glob.

Frontend uses pnpm-lock.yaml, not an absent package-lock:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Use the packageManager-pinned pnpm11.25.0. A directly installed matching pnpm is also suitable.
Set real API configuration and NEXT_PUBLIC_USE_MOCKS=false before a deployment build.
Clean portable builds do not require workstation .openai/hosting.json or the Sites plugin.
Managed previews still require their local preview plugin; it is not replaced with a dummy shim.

## Data and operations follow-through

- Run financial preflight read-only on staging first. Every unmarked reservation requires a reviewed
  accounting classification and wallet/lot reconciliation; allocation presence alone is not proof.
  No automatic balance repair or production conversion was attempted. Historical corrupt balances
  and pre-existing double refunds cannot be safely repaired without the actual data and evidence.
- The new enrolment-operation model uses a deterministic unique _id plus a compound unique index.
  Include it in the existing controlled index rollout; no TTL may erase committed operation recovery.
- Confirm the existing scheduler/maintenance workers and Redis run the new reservation-expiry job.
  Uncertain redemption payments remain held until the existing reconciliation confirms an outcome.
- Smoke real provider callbacks, recorded sell payment, pickup/delivery, refunds and scheme redemption
  on staging with this exact candidate. These integration/provider checks are not established by UI unit tests.

The backend/frontend ZIPs are source candidates, not validated production binaries. Their SHA-256
values and exported-file comparison are supplied in the outer handoff bundle.
