# Phase 6 release audit (fc27b9d → HEAD)

Audit date: 2026-09-21. Scope: production blockers, forbidden values, idempotency, contracts, seeds.

## Original production blocker trace

| # | Issue | Service / helper | Route / worker | Model | Proving tests |
|---|--------|------------------|----------------|-------|----------------|
| 1 | Mandatory first payment | `scheme.service` enrolment | `POST /admin/schemes`, staff enrol | `Scheme`, `LedgerEntry` | `tests/enrolment-phase2.test.js` |
| 2 | Fixed maturity = duration calendar cycle | `calendar-cycle.js`, `scheme-maintenance` | scheduler maintenance | `Scheme.installments` | `tests/plan-phase1-validation.test.js`, `tests/scheme-lifecycle.test.js` |
| 3 | Fixed PENDING → DUE | `scheme-maintenance.service` | scheduler | `Scheme.installments` | `tests/phase-f-scheduler.test.js`, `tests/fixed-payment-phase4-audit.test.js` |
| 4 | Partial/advance disabled | `payment.service`, plan validation | payment record / links | `Scheme.planSnapshot.paymentRules` | `tests/fixed-payment-reservation-phase4.test.js`, `tests/plan-phase1-validation.test.js` |
| 5 | Flexible averaging − reversals | `flexible-lock-settlement.js` | lock transition | `LedgerEntry` | `tests/flexible-lock-phase3.test.js`, `tests/flexible-lock-settlement-phase3.test.js` |
| 6 | Flexible calendar-month cycles | `calendar-cycle.js` | enrol / lock | `Scheme.cycles` | `tests/flexible-lock-phase3.test.js` |
| 7 | Below-min / zero auto closure | `applySystemFlexLockClosure` | `POST` lock | `Scheme.closureReason` | `tests/flexible-lock-settlement-phase3.test.js` |
| 8 | FULL / FORFEIT only (no PRORATE) | `plan.service` validation | plan CRUD | `SchemePlan` | `tests/plan-phase1-validation.test.js` |
| 9 | Purchase adjustment + bill, zero cash | `redemption.service` | redemption complete | `Redemption`, `LedgerEntry` | `tests/redemption-phase5-corrective.test.js`, phase4 gold tests |
| 10 | TRANSFER_TO_SCHEME removed | plan + redemption validators | plan / redemption | enums | `tests/plan-phase1-validation.test.js` |
| 11 | Cash-plan handover exact 22K | `redemption.service`, `gold-rate-lookup` | redemption initiate/complete | `GoldRate` | `tests/gold-redemption-phase4.test.js`, `tests/redemption-phase5-edge-matrix.test.js` |
| 12 | Ledger sequence concurrency | `sequence.service`, `nextSchemeLedgerSequence` | payments / redemption | `Scheme.ledgerNextSequence` | `tests/ledger-sequence-concurrency.test.js` |
| 13 | Missing rate → no zero-weight pay | `payment.service`, gold rate lookup | record payment | `Payment`, `LedgerEntry` | `tests/gold-redemption-phase4.test.js`, payment tests |
| 14 | 22K purity enforcement | `gold-rate-lookup`, model enum | gold-rate POST | `GoldRate` | `tests/gold-redemption-phase4.test.js` |
| 15 | Max enrolment excludes terminal | `scheme-enrollment-status.js` | enrol | `Scheme` count | `tests/enrolment-phase2.test.js` |
| 16 | One-active when tenant enables | `enrolment-in-transaction-validation.js` | enrol transaction | `Tenant.operations` | `tests/enrolment-phase2.test.js` |
| 17 | Fixed online reservation anti-duplicate | `fixed-payment-reservation.js` | payment links / gateway | `PaymentIntent` | `tests/fixed-payment-reservation-phase4.test.js`, `tests/fixed-payment-public-expiry-phase4.test.js` |
| 18 | System-policy principal settlement | `system-policy-closure.js`, `redemption.service` | settlement preview / complete | `Scheme.settlementRequired` | `tests/redemption-system-policy-closure-phase5.test.js`, `tests/flexible-lock-settlement-phase3.test.js` |

## Forbidden / stale scan (summary)

| Pattern | Verdict |
|---------|---------|
| `PRORATE` in src | Rejection tests + comment in `scheme-closure-penalty.js` (safe) |
| `PRORATE` in fix.md | Local notes only (gitignored) |
| `TRANSFER_TO_SCHEME` | Plan validation rejection tests only |
| `CHEQUE` | Valid manual payment mode enum (not removed product-wide) |
| `1440` / 24h link default | Replaced by 30m cap in payment link validation + contract |
| `countDocuments()+1` ledger | Platform invoice numbering only (non-ledger) |
| `systemPolicyClosure: false` | Unit test fixture for penalty math only |
| `__mock_transient_pay__` | Removed (Phase 4) |
| `req.lockReferenceDate` | Not present in src |
| Test hooks (`*test-hooks*`) | Guarded `NODE_ENV=test` |
| `Math.round/floor/ceil` in money | `money.js` uses Decimal.js; weight via explicit modes |

## PhonePe HTTP / webhook

Processor-level coverage: `tests/phase-ab-regression.test.js`, `tests/phonepe-failure-injection.test.js`, `tests/webhook-processors-sdk.test.js`, `tests/fixed-payment-webhook-authority-phase4.test.js`. Invalid signatures and unknown references do not mutate financial rows.

## Idempotency middleware (financial mutations)

| Endpoint class | Rollback on 5xx | Replay safety |
|----------------|-----------------|---------------|
| Payments / redemption / enrol (transactional) | Mongo transaction rolls back | Business keys + idempotency record |
| OTP / signup | Non-financial or staged | Idempotent by key |
| Config / CRUD | Single-document | Safe replay |

Unsafe post-commit 5xx on financial routes: mitigated by transactional boundaries in `withTransaction` and payment/redemption idempotency at intent/link level. Generic `abandonIdempotency` on 5xx allows retry with same key after rollback.

## Index integrity

Run `npm run db:sync-indexes:dry-run` on target environment before release; apply with `npm run db:sync-indexes` on disposable DB only during verification.
