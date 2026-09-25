# SwarnaGrow — QA demo credentials & test data

**Purpose:** Hand this document to the testing team for end-to-end platform testing (Platform, Tenant Admin, Collection Agent, Customer portals).

**Not for production.** All passwords below come from dev/demo seeds only.

---

## 1. Environment setup

### Backend seed (full platform matrix)

Run from `swarnagrow-backend` against the **target MongoDB** (local or shared Atlas). These commands do **not** change your `.env` if you override `MONGODB_URI` on the command line.

```bash
# Platform subscription plans + super-admin
npm run seed

# KAIRALI jeweller — primary E2E tenant (schemes, payments, redemption, cash, support)
npm run seed:demo

# 128 OPS tenants (operation-flag combinations) + MATRIXCORE status matrix
npm run seed:coverage -- --skip-demo

# Optional extras for portal parity scripts
npm run seed:tenant-coverage-gaps
npm run seed:pending-handover
npm run db:sync-indexes
```

Re-running `npm run seed:demo` **replaces all KAIRALI data**. Everyone must sign in again in open browser tabs.

### Frontend (SwarnaGrow-Tenant-Admin)

```bash
# .env.local
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/api/v1   # or your deployed API
NEXT_PUBLIC_USE_MOCKS=false
```

| Service | Typical URL |
|---------|-------------|
| Frontend (tenant + platform + customer + agent) | `http://localhost:3000` or `http://localhost:5173` |
| Backend API | `http://localhost:4000/api/v1` |

### Mock integrations (default dev)

| Integration | Mode | QA note |
|-------------|------|---------|
| OTP | `OTP_PROVIDER=mock` | Always use OTP **`123456`** in development |
| PhonePe / payments | `PROVIDER_MODE=mock` | Online flows simulate success without real UPI |
| WhatsApp | empty / mock | Messaging quotas may apply; sends are not real |

Platform admin password defaults come from backend `.env`: `SEED_PLATFORM_EMAIL` / `SEED_PLATFORM_PASSWORD` (see below).

---

## 2. Portal quick reference

| Portal | URL path | Identifier | Secret |
|--------|----------|------------|--------|
| **Platform** (ops) | `/platform/login` | Email | Password |
| **Tenant admin** | `/login` | Tenant code + staff mobile | PIN |
| **Collection agent** | `/agent/kairali/login` | Mobile | PIN |
| **Customer** | `/customer/kairali/login` | Mobile | OTP `123456` |

Tenant URL slugs are **lowercase** tenant codes (`KAIRALI` → `kairali`, `MATRIXCORE` → `matrixcore`, `OPS001` → `ops001`).

Staff and agent logins use a **4-digit PIN** (`2026`), not a long password.

---

## 3. Platform (super admin)

| Field | Value |
|--------|--------|
| **URL** | `{FRONTEND_BASE}/platform/login` |
| **Email** | `ops@platform.com` |
| **Password** | `1234` (default from `SEED_PLATFORM_PASSWORD` in `.env.example`) |

Use for: tenant lifecycle, subscription plans, platform analytics, cross-tenant operations.

---

## 4. Tenant admin — KAIRALI (primary demo jeweller)

| Field | Value |
|--------|--------|
| **URL** | `{FRONTEND_BASE}/login` |
| **Tenant code** | `KAIRALI` |
| **Staff PIN (all users below)** | `2026` |

### Branches

| Code | Name |
|------|------|
| `MGR` | MG Road — Mangalore (HQ) |
| `KOC` | Kochi Showroom |

### Staff accounts

| Role | Name | Mobile | Branch / scope |
|------|------|--------|----------------|
| Tenant owner | Rahul Nair | `9847012345` | All branches |
| Tenant admin | Divya Admin | `9847012347` | All branches |
| Branch manager | Anu Menon | `9847012346` | Kochi (`KOC`) |
| Branch staff | Priya K | `9847012350` | Mangalore (`MGR`) |
| Branch staff | Sanjay M | `9847012351` | Mangalore (`MGR`) |
| Branch staff | Reena K | `9847012353` | Kochi (`KOC`) |

**Suggested roles for tests**

- **Owner:** approvals, settings, sensitive actions — `9847012345`
- **Tenant admin:** day-to-day admin — `9847012347`
- **Branch-scoped staff:** dues, enrollments, cash — `9847012350` / `9847012353`
- **Branch manager Kochi:** branch-only scope — `9847012346`

### Active plan codes (KAIRALI)

| Code | Type |
|------|------|
| `SAVING11` | Fixed cash (11+1) |
| `FLEXI11` | Flexible then capped |
| `GOLD11` | Gold weight fixed |
| `MICRO12` | Micro saver |
| `SLAB11` | Slab fixed |
| `FEST27` | Draft (inactive for enrolment) |
| `LEG10` | Inactive legacy |

**Gold rate (seed):** ₹7,250/g (22K), tenant-wide for demo day.

---

## 5. Collection agent — KAIRALI

| Field | Value |
|--------|--------|
| **URL** | `{FRONTEND_BASE}/agent/kairali/login` |
| **Mobile** | `9847012352` |
| **PIN** | `2026` |
| **User** | Vijay Field — `COLLECTION_AGENT`, Kochi (`KOC`) |

Field collection, customer enrol/pay on route, pending cash handover to branch (`ENR-0000033` / collector flows in seed).

---

## 6. Customer portal — KAIRALI

| Field | Value |
|--------|--------|
| **URL** | `{FRONTEND_BASE}/customer/kairali/login` |
| **Auth** | OTP only (dev mock) |
| **OTP** | `123456` |

Customers do **not** use staff PIN `2026` on KAIRALI unless tenant settings are changed.

### Customer mobiles (all OTP `123456`)

| Name | Mobile | Typical use |
|------|--------|-------------|
| Sachu Sudhish | `7907753163` | Primary demo customer |
| Lakshmi Nair | `9847123456` | Fixed / HQ |
| Arjun Pillai | `9847234567` | Kochi |
| Meera Das | `9847345678` | |
| Vijay Kumar | `9847456789` | Maturity / redemption stories |
| Deepa Menon | `9847567890` | Kochi |
| Ravi Shankar | `9847678901` | |
| Nisha Thomas | `9847789012` | Grievance / WhatsApp ticket |
| George Mathew | `9847890123` | Kochi |
| Flexi Amal | `9847901234` | Flexible schemes |
| Flexi Beena | `9847912345` | |
| Flexi Cyrus | `9847923456` | Kochi |
| Gold Hari | `9847934567` | Gold-weight schemes |
| Gold Indu | `9847945678` | |
| Gold Jaya | `9847956789` | Kochi |
| Gold Karthik | `9847967890` | |
| Gold Latha | `9847978901` | |
| Gold Manu | `9847989012` | Kochi |
| Gold Neena | `9847990123` | |
| Gold Omar | `9847001234` | |
| Gold Priya G | `9847011111` | Kochi |
| Gold Qadir | `9847022222` | |

---

## 7. KAIRALI enrollment scenario matrix

Use **Enrollments** search by enrollment number or filter by plan (`SAVING11`, `FLEXI11`, `GOLD11`).

### Fixed / cash (`SAVING11` and related)

| Enrollment | Scenario |
|------------|----------|
| `ENR-0000001` | Next installment **due today** (2 prior paid) |
| `ENR-0000002` | Installment 2+ **overdue** (grace elapsed) |
| `ENR-0000003` | **Partially paid** on current installment |
| `ENR-0000004` | Active, 3 paid — **premature closure eligible** |
| `ENR-0000005` | **Matured** — redemption **pending approval** (Vijay) |
| `ENR-0000006` | Maturity ~12 days out, 2 installments left |
| `ENR-0000007` | Recent UPI + CARD (payment mode mix) |
| `ENR-0000008` | **Pending online** payment on ledger |
| `ENR-0000009` | One success payment **reversed** |
| `ENR-0000023` | **Defaulted** — multiple overdue installments |
| `ENR-0000024` | Matured → **redeemed** (cash completed) |
| `ENR-0000025` | Redeemed — **purchase adjustment** |
| `ENR-0000026` | **Premature** — closed with penalty |
| `ENR-0000027` | `MICRO12` active, ₹1,500/mo, 3 paid |
| `ENR-0000028` | `SLAB11` active, ₹3,000/mo slab, 1 paid |

### Flexible (`FLEXI11`)

| Enrollment | Scenario |
|------------|----------|
| `ENR-0000010` | Flexible phase — ₹2,000 collected — **ready to lock** |
| `ENR-0000011` | Locked — ₹1,000/mo cap — **partial** in current cycle |
| `ENR-0000012` | Locked — capped phase (non-cash payments) |
| `ENR-0000029` | Flexible phase — cycle 1 only — ₹500 paid |
| `ENR-0000030` | Zero flex total → **closed premature** |
| `ENR-0000031` | Locked — current capped cycle **fully paid** |
| `ENR-0000032` | Locked — prior capped cycle **expired** (partial unpaid) |

### Gold weight (`GOLD11`)

| Enrollment | Scenario |
|------------|----------|
| `ENR-0000013` | Active, 4 instalments, weight on passbook |
| `ENR-0000014` | Next instalment due — collect at gold rate |
| `ENR-0000015` | Matured — redeemable, no open request |
| `ENR-0000016` | Redemption **pending approval** (gold handover) |
| `ENR-0000017` | **Approved** — cash maturity — ready to complete |
| `ENR-0000018` | **Completed** — redeemed — gold handover |
| `ENR-0000019` | **Completed** — redeemed — cash payout |
| `ENR-0000020` | Premature — approved — early gold handover |
| `ENR-0000021` | Premature — completed — closed premature |
| `ENR-0000022` | Redemption **rejected** — still matured |

### Collector / extended cash

| Enrollment / item | Scenario |
|-------------------|----------|
| `ENR-0000033` | Collector enrol + ₹800 flex payment (KOC) |
| Sanjay (`MGR`) | ~₹800 still in hand after accepted handover |
| Priya (`MGR`) | **Pending handover** ₹1,00,000 — use Cash control → Receive |
| Anu Menon (`KOC`) | **Pending handover** ₹450 |
| Sanjay | **Discrepancy** handover settled (shortfall) in history |
| Priya | Handover **cancelled** |
| Sanjay | Handover **rejected** by owner |
| Vijay (collector) | **Pending handover** ₹800 after field collection |

### Support desk (grievances)

| Priority / status | Topic | Customer |
|-------------------|-------|----------|
| URGENT, SLA overdue | Receipt | Sachu Sudhish |
| IN_PROGRESS | Receipt duplicate | Lakshmi Nair |
| OPEN | Payment (Kochi) | Arjun Pillai |
| WAITING_FOR_CUSTOMER | Maturity | Vijay Kumar |
| OPEN, SLA overdue | WhatsApp | Nisha Thomas |
| RESOLVED (today) | Receipt / app | Meera Das |

**UI pointers:** Support desk → grievances · Cash control → Receive cash / pending handovers · Maturity & redemption → queue · Flexible → filter `FLEXI11` · Enrollments → value basis **Gold weight** or plan `GOLD11`.

---

## 8. MATRIXCORE tenant (scheme status matrix)

Created by `npm run seed:coverage`. Isolated tenant for **scheme type × status** coverage (40 schemes).

| Field | Value |
|--------|--------|
| **Tenant code** | `MATRIXCORE` |
| **Tenant admin URL** | `{FRONTEND_BASE}/login` → code `MATRIXCORE` |
| **Owner mobile** | `9799999901` |
| **Owner PIN** | `2026` |
| **Customer URL** | `{FRONTEND_BASE}/customer/matrixcore/login` |
| **Customer mobile** | `9799999902` |
| **Customer auth** | OTP **`123456`** (tenant is OTP-only) |

Branch: `MX1` (Matrix HQ).

---

## 9. OPS001–OPS128 tenants (operation rules matrix)

Also from `npm run seed:coverage`. **128 tenants**, each with a unique combination of:

- Customer self-enrol / self-registration  
- Customer app write / payments  
- KYC required for enrolment  
- One active scheme per customer  
- Customer login: **OTP only** vs **password only**

| Field | Pattern |
|--------|---------|
| **Tenant codes** | `OPS001` … `OPS128` |
| **Owner mobile** | `9700000000` + (index − 1) → e.g. OPS001 = `9700000000`, OPS002 = `9700000001` |
| **Customer mobile** | `9700000500` + (index − 1) → e.g. OPS001 = `9700000500` |
| **Owner PIN** | `2026` |
| **Customer PIN** | `2026` **only when** that tenant’s `customerLoginMode` is password-only |
| **Customer OTP** | `123456` **when** that tenant’s `customerLoginMode` is OTP-only |

Examples:

| Tenant | Owner login | Customer login |
|--------|-------------|----------------|
| `OPS001` | `9700000000` / `2026` | Check tenant ops flags in Platform or API |
| `OPS002` | `9700000001` / `2026` | Same |
| … | … | … |
| `OPS128` | `9700000127` / `2026` | Same |

Each OPS tenant has one fixed-cash and one flexible plan, one active fixed scheme, and one customer — use for **permission / flag** regression, not for KAIRALI UI richness.

---

## 10. Suggested QA flows (by portal)

### Platform

- Sign in as ops admin  
- List tenants; open KAIRALI and an OPS tenant  
- Subscription / plan tiers (Starter, Growth, Pro, Custom)

### Tenant admin (KAIRALI)

- Dashboard (this month KPIs)  
- **Dues** — collect on due/overdue rows (`ENR-0000001`, `ENR-0000002`)  
- **Enrollments** — detail tabs: ledger, maturity, redemption  
- **Maturity & redemption** — approve/complete/reject (`ENR-0000005`, gold queue)  
- **Cash control** — accept pending handover (Priya / Anu / Vijay)  
- **Support desk** — open grievance, reply, status transitions  
- **Plans** — view draft `FEST27`, inactive `LEG10`  
- **Reports** — enrollment, collection, maturity (filters / export)

### Collection agent

- Login Vijay → assigned customers → record field payment  
- Pending handover visible to branch staff after collection

### Customer (KAIRALI)

- OTP login for Lakshmi / Gold Hari / Flexi Amal  
- View schemes, passbook, make payment (mock gateway)  
- Redemption preview where matured

### Cross-portal

- Same browser: platform + tenant + agent + customer use **separate** storage keys — all four can stay signed in.

---

## 11. Troubleshooting

| Issue | Fix |
|-------|-----|
| 401 / sudden logout | Re-run did not re-seed, but if `seed:demo` ran, sign in again |
| OTP invalid | Use `123456`; confirm `OTP_PROVIDER=mock` and `NODE_ENV=development` |
| Customer cannot pay online | Tenant `customerAppPaymentsEnabled` — true on KAIRALI |
| Gold payment blocked | Ensure gold rate set (seed sets ₹7250/g) |
| Empty tenant list on platform | Run `npm run seed` then `npm run seed:demo` on the API’s MongoDB |

---

## 12. Related docs

- Frontend copy: `SwarnaGrow-Tenant-Admin/docs/DEMO_CREDENTIALS.md`  
- Real-DB E2E checklist: `docs/E2E_REAL_DB_PORTAL_CHECKLIST.md`  
- KAIRALI portal runbook: `docs/TENANT_PORTAL_COVERAGE.md`

---

*Generated for QA handoff from demo seeds (`scripts/seed.js`, `seed-demo.js`, `seed-platform-coverage.js`). Update this file if seed passwords or mobiles change in those scripts.*
