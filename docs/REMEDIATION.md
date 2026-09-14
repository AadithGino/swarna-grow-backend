# SwarnaGrow remediation log

Audit findings fixed in Phases 1–3, with the commit and guarding test for each.

Verification: `npm run check` and `npm test` both pass (60 tests).

---

## Phase 1 — Critical

| Finding | Commit | Test |
|---|---|---|
| **1.1** Unauthenticated password reset account takeover | `542e863` | `tests/auth-security.test.js` |
| **1.2** Default secrets accepted in production | `b2bfe20` | `tests/env-production-secrets.test.js` |
| **1.3** Admin routes without mandatory permissions | `8c6d2e7` | `tests/authorization.test.js` (+ `scripts/check-route-coverage.js`) |

---

## Phase 2 — High

| Finding | Commit | Test |
|---|---|---|
| **2.1** OTP in-memory / live throw / fixed `123456` outside test | `3df5949` | `tests/otp-provider.test.js` |
| **2.2** Pending cash handovers not reserved | `864e51e` | `tests/cash.test.js` (double full-balance handover) |
| **2.3** Incomplete future-cycle sequencing | `9eaf139` | `tests/flexible-cycles.test.js`, `tests/flexible-rules.test.js` |
| **2.4** Cap reached conflated with below-minimum | `28c6d60` | `tests/payments-phase2.test.js` (`CURRENT_CYCLE_CAP_REACHED`) |
| **2.5** `positionVersion: 0` hole / rename to `expectedPositionVersion` | `28c6d60` | `tests/payments-phase2.test.js` |
| **2.6** `maxPaymentsPerCycle` only on intent path | `28c6d60` | `tests/payments-phase2.test.js` |

---

## Phase 3 — Medium

| Finding | Commit | Test |
|---|---|---|
| **3.1** Audit `sanitize()` corrupts arrays | `c5e57a1` | `tests/phase3-medium.test.js` |
| **3.2** PhonePe timing-unsafe compare / parse before verify | `adaa190` | `tests/phase3-medium.test.js` |
| **3.3** Idempotency stuck `PROCESSING` | `d0e12ef` | `tests/phase3-medium.test.js` |
| **3.4** Cash `DISCREPANCY` never set; cancel wrote `REJECTED` | `ced4962` | `tests/cash.test.js`, `tests/phase3-auth-cash.test.js` |
| **3.5** Ambiguous multi-tenant login | `9ad523c` | `tests/phase3-auth-cash.test.js` |
| **3.6** Public tenant resolve enumeration | `9ad523c` | `tests/phase3-auth-cash.test.js` |
| **3.7** Ledger sequence `countDocuments + 1` races | `4f256ad` | Covered via payment/reversal paths in `tests/payments.test.js` |
| **3.8** WhatsApp webhook processed before persist | `4f256ad` | Behavioural (persist-then-queue); no live webhook harness |
| **3.9** Missing customer route validators | `4f256ad` | Validators wired on admin customer routes; exercised by `npm run check` / Zod |

---

## Phase 4 — Suite

| Suite | File | Covers |
|---|---|---|
| Integration harness | `tests/helpers/db.js` | MongoMemoryReplSet, seed fixtures, bearer helper |
| Security | `tests/auth-security.test.js` | Phase 1.1 |
| Authorization matrix | `tests/authorization.test.js` | Phase 1.3 roles × module routes |
| Isolation | `tests/isolation.test.js` | Cross-tenant / cross-branch → 404 |
| Flexible cycles | `tests/flexible-cycles.test.js` | Phase 2.3 + remainder / no carry-forward |
| Cash integrity | `tests/cash.test.js` | Phase 2.2 / 3.4 |
| Payment allocation | `tests/payments.test.js` | Fixed oldest-first, overpay, gateway block, reverse append |

---

## Intentionally incomplete / notes

1. **Live OTP delivery** — Not implemented. `PROVIDER_MODE=live` with a non-mock `OTP_PROVIDER` fails at API startup (`assertOtpProviderReady`). Mock OTP remains for local/dev; fixed `123456` only when `NODE_ENV=test`.
2. **WhatsApp webhook** — Persist-then-queue is implemented; there is no integration test that drives the BullMQ worker end-to-end in CI (Redis optional in tests).
3. **Cash reverse → adjustment** — Payment reverse after an accepted handover does **not** rewrite the handover (guarded). Creating a balancing `CashAdjustment` when collected cash was already accepted is not implemented; balance can go negative in that edge case until ops credit an adjustment manually.
4. **Git history** — Repo was initialized during remediation; `542e863` (password reset) landed before the baseline tree commit `8f3e82d`.

---

## Commit index (newest first)

```
4f256ad  3.7–3.9 ledger / WhatsApp / validators
9ad523c  3.5–3.6 login selection + tenant resolve
ced4962  3.4 cash DISCREPANCY + CANCELLED
d0e12ef  3.3 idempotency stale reclaim
adaa190  3.2 PhonePe timing-safe verify
c5e57a1  3.1 audit sanitize arrays
28c6d60  2.4–2.6 payment caps / versions / count
9eaf139  2.3 future-cycle sequencing
864e51e  2.2 pending cash reserve
3df5949  2.1 OTP Redis + startup fail
8c6d2e7  1.3 mandatory permissions
b2bfe20  1.2 production secrets
542e863  1.1 password reset takeover
```
