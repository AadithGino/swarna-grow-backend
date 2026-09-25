# Real-DB E2E Portal Checklist

Run date: 2026-09-22  
Environment: local backend + local frontend, seeded dev MongoDB (non-test DB)

## Scope

This checklist validates end-to-end platform behavior for:

- Tenant Admin portal (`/login`)
- Customer portal (`/customer/kairali/login`)
- Collection Agent portal (`/agent/kairali/login`)
- Platform portal (`/platform/login`)

Coverage includes payment, settlement, redemption, flexible lock, maturity, reports, filters, role scoping, and payload parity with DB.

---

## Seed and prerequisites

Executed on real DB:

- `npm run seed:demo`
- `npm run seed:coverage -- --skip-demo`

Key seeded coverage:

- KAIRALI full lifecycle matrix (fixed/flexible/gold, maturity/redemption states, cash handovers, grievances)
- 128 OPS tenants for operation-rule combinations
- `MATRIXCORE` tenant with scheme-type × scheme-status coverage

---

## Automated E2E checks (real DB)

## 1) Lifecycle smoke (payments + settlement + redemptions)

Command:

- `node --env-file=.env scripts/phase6-smoke-flow.js`

Status: **PASS**

Validated flows:

- Fixed plan enrol and manual payment
- Online payment persist + idempotent replay
- Flexible lock transition
- System-policy settlement completion
- Maturity transition
- Redemption completion:
  - `CASH`
  - `GOLD_HANDOVER`
  - `PURCHASE_ADJUSTMENT`
- Final invariants (no pending outbox drift)

## 2) Tenant-admin API + DB cross-check

Command:

- `node --env-file=.env scripts/audit-admin-pages-full.js`

Status: **PASS** (`123 passed, 0 failed`)

Validated:

- Dashboard, nav badges, collections summary vs DB
- Defaulters, maturities, flexible locks, pending/late-success payments
- Cash control, messaging, reminders, settings, subscription, gold rates
- Customers/schemes/payments/grievances/redemptions list/detail
- Branch-manager scope constraints

## 3) Frontend-facing matrix (period/filter/report/role)

Command:

- `node --env-file=.env scripts/audit-frontend-full.js`

Status: **PASS** (`142 passed, 0 failed`)

Validated:

- Period filters (`TODAY`, `THIS_WEEK`, `THIS_MONTH`, `LAST_MONTH`, `LAST_3_MONTHS`, custom)
- Branch filters (`ALL` + specific branches)
- Status filters across customers/schemes/payments/handovers/redemptions/grievances
- Report matrix (collection, enrolment, outstanding, maturity/redemption, gold accrual, staff/customer performance, etc.)
- Detail endpoints required by UI drill-down
- Platform summary APIs

## 4) Customer + Staff + Collector payload parity

Command:

- `node --env-file=.env scripts/audit-app-apis-full.js`

Status: **PARTIAL PASS** (`263 field checks passed, 1 mismatch`)

Mismatch:

- Notifications unread count mismatch for customer `9847234567`  
  API unread count = `2`, DB-derived expected = `4`.

## 5) Exhaustive operation-combination + portal-action matrix

Command:

- `node --env-file=.env scripts/audit-realdb-portal-action-matrix.js`

Status: **PASS** (`1605 passed, 0 failed`)

Validated across **all 128 OPS tenants**:

- Customer login path per tenant login mode (`OTP_ONLY`/`PASSWORD_ONLY`)
- `tenantCapabilities` parity against `tenant.operations` + `tenant.settings`
- Profile write gating (`CUSTOMER_APP_VIEW_ONLY`) by `customerAppWriteEnabled`
- Nominee write/delete gating and success behavior
- KYC submit behavior for KYC-required vs KYC-disabled vs view-only
- Payment creation path gating (`CUSTOMER_PAYMENTS_DISABLED`) by payments flags
- Plan self-enrol visibility behavior when self-enrol disabled

Validated on KAIRALI customer flows:

- Settlement preview for matured gold scheme across all allowed modes:
  - `CASH`
  - `GOLD_HANDOVER`
  - `PURCHASE_ADJUSTMENT`
- Settlement preview for matured cash scheme (`CASH`)
- Customer redemption-request creation path (or skip when already open)

---

## Frontend code health checks

Tenant Admin repo:

- `npm run build` -> **PASS**
- `npm run lint:customer` -> **FAIL** (existing lint violations)
- `npm run lint:agent` -> **FAIL** due to warning threshold (`--max-warnings 0`)

These lint failures are pre-existing quality issues and do not invalidate runtime API flow pass results.

---

## Manual click-through checklist (UI confirmation)

Use seeded credentials from `SwarnaGrow-Tenant-Admin/docs/DEMO_CREDENTIALS.md`.

For each step, mark `PASS/FAIL` in execution notes.

## Tenant Admin (`/login`, KAIRALI)

- [ ] Dashboard totals align with cards/charts for `THIS_MONTH`
- [ ] Collections summary updates when changing period and branch
- [ ] Flexible capped scheme detail shows `cycleCap`, `paidThisCycle`, `remainingThisCycle`
- [ ] Maturity queue actions complete for cash/gold/purchase-adjustment flows
- [ ] Cash control shows pending/accepted/rejected/cancelled handovers correctly
- [ ] Reports render for each report key and support CSV export action
- [ ] Customer detail drill-down loads profile, schemes, payments, messages tabs without missing fields

## Agent Portal (`/agent/kairali/login`)

- [ ] Login with collector works
- [ ] Customer search/list scoped to assigned branch
- [ ] Collect payment flow accepts supported modes and writes receipt data
- [ ] Collector cash in hand and handover state updates after collection/handover actions

## Customer Portal (`/customer/kairali/login`)

- [ ] OTP login works (`123456`)
- [ ] Home card labels for flexible capped schemes show this-cycle values clearly
- [ ] Scheme detail shows progress card and payable-range values consistent with API
- [ ] Payment initiation + status polling + receipt access works
- [ ] Redemption request creation works for eligible matured schemes
- [ ] Notifications list/read state works (watch unread count issue noted above)

## Platform Portal (`/platform/login`)

- [ ] Tenant list, summary KPIs, subscription plans load
- [ ] Tenant detail page for KAIRALI and MATRIX tenants loads

---

## Known issues from this run

1. `audit-app-apis-full` unread notification count mismatch for one customer.
2. `audit-gaps-full.js` expectations are stale vs current backend behavior and needs script updates before using as gate.
3. Frontend lint debt (customer + agent modules) should be cleaned if lint is a release gate.

---

## Visual click run (portal by portal)

Browser automation run:

- `FRONTEND_BASE=http://localhost:5173 npx playwright test scripts/visual-portal-click-run.spec.js --reporter=line`

Status: **PASS (4/4)**

- **Tenant portal**: PASS (login leaves `/login`)
- **Agent portal**: PASS (login flow and post-login route transition)
- **Customer portal**: PASS (OTP request/verify flow and post-login route transition)
- **Platform portal**: PASS (`Sign in securely` enables and leaves `/platform/login`)

The first visual run filled tenant/platform fields before React hydration, so those values were wiped and submit never completed. The runner now waits for the page to settle, then confirms each input kept its value before clicking.

Artifacts:

- `docs/e2e-visual-screenshots/01-tenant-login-page.png`
- `docs/e2e-visual-screenshots/02-tenant-after-login.png`
- `docs/e2e-visual-screenshots/03-agent-login-page.png`
- `docs/e2e-visual-screenshots/04-agent-after-login.png`
- `docs/e2e-visual-screenshots/05-customer-login-page.png`
- `docs/e2e-visual-screenshots/06-customer-after-login.png`
- `docs/e2e-visual-screenshots/07-platform-login-page.png`
- `docs/e2e-visual-screenshots/08-platform-after-login.png`

---

## Visual business-flow click run

Browser automation run:

- `FRONTEND_BASE=http://localhost:5173 npx playwright test scripts/visual-portal-flows.spec.js --reporter=line --workers=1`

Status: **PASS**

Clicked in the browser (dialogs opened and closed; payments and redemptions were not submitted):

- **Tenant admin (KAIRALI):** every nav surface, settings tabs, all 14 reports, a customer detail with every tab, and enrollment pages for fixed, flexible-lock, gold, defaulted, and redeemed schemes, including settlement-preview mode switching
- **MATRIXCORE:** every seeded scheme type × status enrollment page (40), then the matrix customer’s scheme detail pages
- **Customer (KAIRALI):** Lakshmi, Flexi Amal, and Gold Hari through home, schemes, payments, notifications, profile, nominee, KYC, security, support, gold rate, branches, and plans, plus scheme detail, payment sheet, and redemption-mode dialog where the scheme allows it
- **Agent (KAIRALI):** home, collect search, customer record, collect form, history, handover, report, and account
- **Platform:** overview, jewellers, create-jeweller form, one jeweller detail, plans, templates, monitoring, audit, and settings
- **Operation combinations:** all 128 OPS tenants, customer login in that tenant’s mode (OTP or password), then home and schemes. **128/128 passed**

Screenshots: `docs/e2e-visual-screenshots/flows/`. OPS step log: `docs/e2e-visual-flow-results.json`.

---

## Recommended gate before release

Minimum release gate on real DB:

1. `node --env-file=.env scripts/phase6-smoke-flow.js`
2. `node --env-file=.env scripts/audit-admin-pages-full.js`
3. `node --env-file=.env scripts/audit-frontend-full.js`
4. `node --env-file=.env scripts/audit-app-apis-full.js` (must be 0 mismatches)
5. Frontend `npm run build` + manual click-through checklist above

