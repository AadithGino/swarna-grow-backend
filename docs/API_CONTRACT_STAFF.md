# Collection Agent App API Contract

**Audience:** Field collector mobile app (`TENANT_USER`, role **`COLLECTION_AGENT`** only)

**Base:** `http://localhost:4000` · **Prefix:** `/api/v1` (except `/health*`)

> Money = integer **paise**. Weight = integer **mg**. List/detail payloads may use Mongo **`_id`**; map to **`id`** in UI if your design system prefers it ([Appendix B](#appendix-b--dto-notes)).

Full **`BRANCH_STAFF`** / counter staff surface (enrol, KYC, grievances, dues, payment links, etc.) lives on the same **`/staff/*`** handlers but is **out of scope** for this document — see [API_CONTRACT.md](./API_CONTRACT.md) staff sections.

## Scope

- **`/auth/*`** — tenant login, refresh, logout, profile, password, devices
- **`/staff/*`** — **read-only customer lookup**, **read scheme + collect cash**, **cash balance & handover**, **gold rate**, **profile** (branch-scoped)
- Health checks (shared)

**Route count (this app):** **25** (see [Appendix C](#appendix-c--route-inventory-collection-agent-app)). Request/response examples: [Appendix D](#appendix-d--complete-request--response-reference).

See also: [Full contract](./API_CONTRACT.md) · [Admin portal](./API_CONTRACT_ADMIN.md) · [Customer](./API_CONTRACT_CUSTOMER.md) · [Panels index](./API_CONTRACT_PANELS.md)

## Locked product rules (V1)

- **Role:** Login user must be **`COLLECTION_AGENT`** with a non-null **`branchId`**. Reject or hide the app for other tenant roles (they should use admin or full staff builds).
- **Branch scope:** Every `/staff/*` call is scoped to the authenticated user’s **branch** and tenant. Do **not** send `branchId` to override scope.
- **Online-only:** No offline queue, sync, or geo-stamping in V1.
- **Cash-only collection UI:** The collect screen records **`mode: "CASH"`** only. Do not expose UPI/card/cheque or payment links in this app (backend may accept other modes for other roles — ignore here).
- **Cash in hand:** Successful **`CASH`** collections (minus reversals), minus **accepted** handovers and cash adjustments — **pending** handovers do **not** reduce **`cashInHandPaise`** ([Cash & handover](#cash--handover)).
- **Available to submit:** **`availableForHandoverPaise`** = **`cashInHandPaise`** − **`cashPendingAcceptancePaise`** (floor 0). Handover amount must not exceed this.
- **Flexible schemes:** Always **`GET .../payable-range`** immediately before **`POST /staff/payments`**; send **`expectedPositionVersion`** (or fixed **`expectedVersion`**) from that response.
- **Gold-weight schemes:** Call **`GET /staff/gold-rate/current`** before showing the collect form; block submit if rate missing (**`GOLD_RATE_NOT_SET`**).
- **Payment source:** Successful collections return **`source: "STAFF_APP"`**.
- **Handover acceptance:** Agents submit cash; **branch manager / admin** accepts on **`/admin/cash/handovers/*`** (not in this app).

**Permissions** (`ROLE_PERMISSIONS.COLLECTION_AGENT`): `customer.read`, `scheme.read`, `payment.read`, `payment.record`, `cash.read`, `cash.handover`, `gold-rate.read`.

**Demo (KAIRALI):** tenant code **`KAIRALI`**, mobile **`9847012352`**, password **`Swarna@2026`** (Kochi branch).

## App UI (V1)

Mobile-first layout. **Do not** implement staff home, enrol, customer create/edit, dues lists, grievances, WhatsApp share, payment links, or push in this build.

### Navigation

| Tab / entry | Screen | APIs |
|-------------|--------|------|
| **Home** | Cash dashboard | `GET /staff/cash/summary`; optional today tile via `GET /staff/collections/summary?from=&to=` |
| **Collect** | Customer search | `GET /staff/customers?q=`; optional `GET .../check-mobile?mobile=` |
| **History** | Collections & submissions | `GET /staff/payments` and/or `GET /staff/cash/collections`; `GET /staff/cash/handovers` |
| **Account** | Profile & session | `GET /staff/profile`, `GET /auth/me`; `POST /auth/change-password`, `POST /auth/logout` |

Global: on **`401`**, `POST /auth/refresh` then retry (same pattern as tenant admin). Mutations: **`X-Idempotency-Key`**.

### Screen: Login

- Fields: tenant code (or resolve if single-tenant build), mobile, password.
- **`POST /auth/login`** with `deviceId`, `platform`, `appVersion`.
- After login: assert **`data.user.role === "COLLECTION_AGENT"`** and **`branchId`** present; otherwise show “This app is for collection agents only” and logout.
- Persist refresh token securely; route to **Home**.

### Screen: Home

```
┌─────────────────────────────┐
│  Branch name (from /auth/me) │
│  ─────────────────────────── │
│  Cash in hand    ₹18,500     │  ← cashInHandPaise (custody until branch accepts)
│  Collected today ₹7,000      │  ← optional collections/summary
│  Pending submit  ₹0          │  ← cashPendingAcceptancePaise
│  [ Collect payment ]         │  → Collect tab / search
│  [ Submit cash to branch ]   │  → Handover (max = availableForHandoverPaise)
└─────────────────────────────┘
```

- **`GET /staff/cash/summary`** on focus and after every successful payment or handover.
- Optional gold-rate chip: **`GET /staff/gold-rate/current`** when tenant sells gold-weight plans (hide if 404 / not used).

### Screen: Search → Customer detail

- Debounced search → **`GET /staff/customers?q=`** (name, mobile, customer number, passbook).
- Row tap → **`GET /staff/customers/:customerId`**.
- Show: name, mobile, passbook, **active schemes** (from customer/scheme relations in payload).
- **No** “Add customer”, KYC, or nominee actions.
- Scheme row tap → **Collect payment** flow.

### Screen: Collect payment

1. **`GET /staff/schemes/:schemeId`** — plan name, status, value basis (cash vs gold).
2. If gold-weight: **`GET /staff/gold-rate/current`** — show rate per gram and business date.
3. **`GET /staff/schemes/:schemeId/payable-range`** (`?targetCycle=` for flexible capped).
4. Form:
   - Amount between `minPayablePaise` and `maxPayablePaise` (use `suggestedPaise` as default).
   - **Mode:** fixed **Cash** (no picker in V1).
   - Optional reference/remarks (notes about notes/coins).
5. **`POST /staff/payments`** with idempotency key; include `expectedVersion` or `expectedPositionVersion` from step 3.
6. Success: show **`receiptNumber`**, **`amountPaise`**, optional **`weightMg`** for gold; offer “Collect again” (refresh payable-range) or back to customer/home.
7. On **`409 PAYMENT_POSITION_CHANGED`**: re-fetch payable-range and ask user to confirm new bounds.

Optional read-only: **`GET .../passbook`** for last few ledger lines (trust / dispute avoidance).

### Screen: History — Collections

- **`GET /staff/payments`** (cursor, branch-scoped; prefer recent first).
- Alternatively **`GET /staff/cash/collections`** if you only want cash rows.
- Row: receipt #, customer name, amount, time, scheme snippet.

### Screen: Submit cash (handover)

- Entry from Home when **`availableForHandoverPaise > 0`**.
- Show max submittable = **`availableForHandoverPaise`** (cash in hand minus pending submissions).
- Amount + optional remarks → **`POST /staff/cash/handovers`**.
- Success: status **`PENDING`** — branch must accept in admin app; **`cashInHandPaise`** unchanged; **`cashPendingAcceptancePaise`** increases.

### Screen: History — Submissions

- **`GET /staff/cash/handovers`** — pending + accepted/rejected/cancelled.
- Row tap → **`GET /staff/cash/handovers/:handoverId`**.
- If **`PENDING`**: show **Cancel** → **`POST .../cancel`** (idempotent).

Status copy for agents:

| Status | UI |
|--------|-----|
| `PENDING` | “Waiting for branch acceptance” + Cancel |
| `ACCEPTED` | “Received by branch” |
| `REJECTED` / `DISCREPANCY` | Show reason; contact manager (out of app) |
| `CANCELLED` | “You cancelled this submission” |

### Screen: Account

- **`GET /staff/profile`** + **`GET /auth/me`** for name, mobile, branch, tenant.
- Change password → **`POST /auth/change-password`**.
- Logout → **`POST /auth/logout`**.
- **Omit** notifications inbox and FCM registration in V1.

### Flow (end-to-end)

```text
Login → Home (cash summary)
  → Search customer → Customer → Scheme → Payable range → POST payment (CASH)
  → Home (updated cash in hand)
End of route / shift
  → Submit cash → POST handover (PENDING)
  → History → submission accepted (admin) → cash in hand cleared
```

## Conventions

**Success**

```json
{
  "success": true,
  "data": {},
  "meta": {
    "nextCursor": "string|null",
    "hasMore": false,
    "limit": 20,
    "total": 0
  }
}
```

**Error**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "...",
    "details": [{ "field": "body.amountPaise", "message": "..." }],
    "traceId": "uuid"
  }
}
```

**Headers:** `Authorization: Bearer <accessToken>`, `X-Idempotency-Key: <uuid>` on mutating routes, `Content-Type: application/json`

**MoneyRef:** `{ "amountPaise": 100000, "amountDisplay": "₹1,000" }`  
**WeightRef:** `{ "weightMg": 1250, "weightDisplay": "1.250 g" }`

**Token TTL:** `expiresIn` on auth responses is an **integer number of seconds** (refresh session default **365 days** via `REFRESH_TOKEN_DAYS`; access JWT remains short-lived — clients should refresh on `401` like the tenant admin portal).

**Optimistic concurrency:** Fixed schemes: **`expectedVersion`** from payable-range. Flexible schemes: **`expectedPositionVersion`** from **`GET .../payable-range`** (alias **`positionVersion`** deprecated).

**Shared payloads:** **Customer read**, **scheme read**, **payments**, **payable-range**, **passbook**, and **cash handover** bodies match **`/admin/*`** equivalents unless noted. See [API_CONTRACT_ADMIN.md](./API_CONTRACT_ADMIN.md).

---

## Health

| Method | Path | Auth |
|--------|------|------|
| GET | `/health` | none |
| GET | `/health/ready` | none |

**`GET /health` — response (200):** `{ "status": "ok", "timestamp": "2026-09-17T06:15:00.000Z" }`

**`GET /health/ready` — response (200):** `{ "database": "ready", "queue": "ready" }`

(Full envelope examples: Appendix D **#1–#2**.)

---

## Auth (`/api/v1/auth/*`)

Collection agent app authenticates as **`TENANT_USER`** via **`/auth/*`** (not customer **`/app/auth/*`**).

| Method | Path | Notes |
|--------|------|--------|
| POST | `/auth/login` | Issue access + refresh tokens |
| POST | `/auth/refresh` | Rotate refresh token |
| POST | `/auth/logout` | Revoke refresh family for device |
| GET | `/auth/me` | Current user + tenant context |
| POST | `/auth/change-password` | Authenticated password change |
| GET | `/auth/devices` | Active sessions for the user |

**`COLLECTION_AGENT`** users without `branchId` cannot use `/staff/*` — provisioning must assign a branch.

### `POST /api/v1/auth/login`

**Request:**

```json
{
  "tenantCode": "KAIRALI",
  "mobile": "9847012352",
  "password": "Swarna@2026",
  "deviceId": "collector-pixel-8-001",
  "platform": "android",
  "appVersion": "1.0.0"
}
```

**Response (200):**

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr_01HQ8Z9K3M2N4P5Q6R7S8T9U",
      "name": "Vijay Field",
      "role": "COLLECTION_AGENT",
      "tenantId": "tnt_01HQ7A2B3C4D5E6F7G8H9J",
      "branchId": "brn_01HQ7KOCHI002",
      "permissions": ["CUSTOMER_READ", "SCHEME_READ", "PAYMENT_READ", "PAYMENT_RECORD", "CASH_READ", "CASH_HANDOVER", "GOLD_RATE_READ"],
      "mustSetPassword": false
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "rt_48charOpaqueToken...",
    "expiresIn": 1800,
    "tokenType": "Bearer"
  }
}
```

**Response (409)** when the same mobile exists at multiple tenants and `tenantCode` was omitted:

```json
{
  "success": false,
  "error": {
    "code": "TENANT_SELECTION_REQUIRED",
    "message": "Select a jewellery to continue.",
    "details": {
      "tenants": [
        { "tenantCode": "KAIRALI", "displayName": "Kairali Jewellers", "logoUrl": null }
      ]
    }
  }
}
```

### `POST /api/v1/auth/refresh`

**Request:**

```json
{
  "refreshToken": "rt_48charOpaqueToken..."
}
```

**Response (200):**

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "rt_newRotatedToken...",
    "expiresIn": 1800,
    "tokenType": "Bearer"
  }
}
```

### `POST /api/v1/auth/logout`

**Request:**

```json
{
  "refreshToken": "rt_48charOpaqueToken..."
}
```

**Response (200):**

```json
{
  "success": true,
  "data": {
    "loggedOut": true
  }
}
```

### `GET /api/v1/auth/me`

**Request:** none.

**Response (200):** Appendix D **#6** (staff user + permissions; same family as login `user`).

### `POST /api/v1/auth/change-password`

**Request / response:** Appendix D **#7**.

### `GET /api/v1/auth/devices`

**Request / response:** Appendix D **#8**.

---

## Customers (lookup only)

| Method | Path | Idempotent |
|--------|------|------------|
| GET | `/staff/customers` | no — cursor list; query `q`, `cursor`, `limit` |
| GET | `/staff/customers/check-mobile` | no — query `mobile` → `{ exists, customerId? }` |
| GET | `/staff/customers/:customerId` | no — schemes list for collect flow |

Wire shapes match **`GET /admin/customers/*`**. This app does **not** call create/update/KYC/nominee routes.

### `GET /api/v1/staff/customers?q=9847&limit=20`

**Response (200):**

```json
{
  "success": true,
  "data": [
    {
      "_id": "cus_01HQ8Z9CUS001",
      "tenantId": "tnt_01HQ7A2B3C4D5E6F7G8H9J",
      "branchId": "brn_01HQ7A9MGR001",
      "customerNumber": "C000412",
      "name": "Anjali Menon",
      "mobile": "+919847654321",
      "email": "anjali@example.com",
      "status": "ACTIVE",
      "passbookNumber": "MGR/2026/00412",
      "version": 3
    }
  ],
  "meta": {
    "nextCursor": null,
    "hasMore": false,
    "limit": 20
  }
}
```

### `GET /api/v1/staff/customers/check-mobile?mobile=%2B919847654321`

**Response (200):**

```json
{
  "success": true,
  "data": {
    "exists": true,
    "customerId": "cus_01HQ8Z9CUS001"
  }
}
```

---

## Schemes (read + collect)

| Method | Path | Notes |
|--------|------|--------|
| GET | `/staff/schemes/:schemeId` | Scheme detail (admin-shaped document) |
| GET | `/staff/schemes/:schemeId/payable-range` | Min/max/suggested/`positionVersion`; query `targetCycle?` for flexible |
| GET | `/staff/schemes/:schemeId/passbook` | Optional — `{ scheme, ledger[] }` on customer scheme screen |

### `GET /api/v1/staff/schemes/:schemeId/payable-range`

Fixed scheme example:

**Response (200):**

```json
{
  "success": true,
  "data": {
    "model": "FIXED",
    "installmentNumber": 3,
    "minPayablePaise": 250000,
    "maxPayablePaise": 250000,
    "suggestedPaise": 250000,
    "expectedVersion": 12,
    "payable": true
  }
}
```

Flexible capped phase (query **`?targetCycle=2026-09`**):

**Response (200):**

```json
{
  "success": true,
  "data": {
    "model": "FLEXIBLE",
    "phase": "CAPPED",
    "contributionIsOptional": true,
    "targetCycle": "2026-09",
    "minPayablePaise": 10000,
    "maxPayablePaise": 150000,
    "suggestedPaise": 150000,
    "paymentIncrementPaise": 100,
    "unusedAllowanceCarriesForward": false,
    "positionVersion": 7,
    "payable": true,
    "nextCycleAction": "PAY_CURRENT_CYCLE"
  }
}
```

---

## Payments & collections summary

| Method | Path | Notes |
|--------|------|--------|
| POST | `/staff/payments` | **Record collection** — `mode` one of **`ManualPaymentMode`** (`CASH`, `UPI`, `CARD`, `BANK_TRANSFER`, `CHEQUE`); only **`CASH`** affects agent cash-in-hand; **`source: STAFF_APP`** on success |
| GET | `/staff/payments` | Cursor list (branch-scoped) — **History → Collections** |
| GET | `/staff/collections/summary` | Optional — today tile on **Home** (`from` / `to` query dates) |

Collect flow:

1. `GET /staff/schemes/:schemeId/payable-range`
2. `POST /staff/payments` with `mode: "CASH"` and matching version fields

### `POST /api/v1/staff/payments`

**Request** (fixed scheme, cash — **collection agent V1**):

```json
{
  "schemeId": "sch_01HQ8Z9ENR000456",
  "amountPaise": 250000,
  "mode": "CASH",
  "expectedVersion": 12,
  "reference": "Notes: two ₹500 notes",
  "remarks": "Collected in field"
}
```

**Request** (flexible capped — **`expectedPositionVersion` required**, still **`mode: "CASH"`**):

```json
{
  "schemeId": "sch_01HQ8Z9FLEX001",
  "amountPaise": 75000,
  "mode": "CASH",
  "targetCycle": "2026-09",
  "expectedPositionVersion": 7,
  "reference": "Cash"
}
```

**Response (201):**

```json
{
  "success": true,
  "data": {
    "_id": "pay_01HQ8Z9PAY001234",
    "tenantId": "tnt_01HQ7A2B3C4D5E6F7G8H9J",
    "branchId": "brn_01HQ7A9MGR001",
    "schemeId": "sch_01HQ8Z9ENR000456",
    "customerId": "cus_01HQ8Z9CUS001",
    "receiptNumber": "RCP-2026-0001234",
    "amountPaise": 250000,
    "allocatedAmountPaise": 250000,
    "weightMg": 345,
    "ratePerGramPaise": 724000,
    "mode": "CASH",
    "status": "SUCCESS",
    "source": "STAFF_APP",
    "collectedBy": "usr_01HQ8Z9K3M2N4P5Q6R7S8T9U",
    "targetCycle": "2026-09",
    "paidAt": "2026-09-17T11:05:22.000Z",
    "auditEventId": "aud_01HQ8Z9AUD001",
    "schemeVersion": 13,
    "positionVersion": 8
  }
}
```

Gold-weight schemes include **`weightMg`** / **`ratePerGramPaise`** on the payment row when a rate exists for the business day.

### `GET /api/v1/staff/collections/summary?from=2026-09-17&to=2026-09-17`

**Response (200):**

```json
{
  "success": true,
  "data": {
    "amountPaise": 1350000,
    "count": 8,
    "byMode": [
      { "mode": "CASH", "label": "Cash", "amountPaise": 700000, "count": 4 },
      { "mode": "UPI", "label": "UPI", "amountPaise": 300000, "count": 2 },
      { "mode": "CARD", "label": "Card / POS", "amountPaise": 200000, "count": 1 },
      { "mode": "ONLINE_GATEWAY", "label": "Online payment", "amountPaise": 150000, "count": 1 }
    ]
  }
}
```

---

## Cash & handover

| Method | Path | Notes |
|--------|------|--------|
| GET | `/staff/cash/summary` | Staff member cash balance breakdown |
| GET | `/staff/cash/collections` | Cash-mode payment list (alias of filtered payments) |
| POST | `/staff/cash/handovers` | Staff initiates handover — body `{ amountPaise, remarks?, staffId?, branchId? }` (staffId/branchId ignored for staff initiator; server uses auth) |
| GET | `/staff/cash/handovers` | Staff’s handovers (pending + history) |
| GET | `/staff/cash/handovers/:handoverId` | Detail — must belong to auth staff |
| POST | `/staff/cash/handovers/:handoverId/cancel` | Cancel **pending** handover |

### `GET /api/v1/staff/cash/summary`

**Request:** none.

**Response (200):**

```json
{
  "success": true,
  "data": {
    "cashCollectedPaise": 2500000,
    "cashInHandPaise": 1850000,
    "cashPendingAcceptancePaise": 0,
    "availableForHandoverPaise": 1850000,
    "collectedPaise": 2500000,
    "handedOverPaise": 650000,
    "adjustmentPaise": 0
  }
}
```

**Handover lifecycle (staff side):**

1. Staff **`POST /staff/cash/handovers`** → status **`PENDING`**; **`cashPendingAcceptancePaise`** increases; **`cashInHandPaise`** unchanged until branch accepts.
2. Branch manager / admin accepts or rejects via **`/admin/cash/handovers/:id/accept|reject`** (not staff routes).
3. Staff may **`POST .../cancel`** while still pending.

Admin oversight: **`/admin/cash/overview`**, **`/admin/cash/staff-balances`**, **`/admin/cash/handovers/*`** — see [API_CONTRACT_ADMIN.md](./API_CONTRACT_ADMIN.md).

### `POST /api/v1/staff/cash/handovers`

**Request:**

```json
{
  "amountPaise": 1850000,
  "remarks": "Closing handover — MG Road counter"
}
```

**Response (201):**

```json
{
  "success": true,
  "data": {
    "_id": "csh_01HQ8Z9HO001",
    "tenantId": "tnt_01HQ7A2B3C4D5E6F7G8H9J",
    "branchId": "brn_01HQ7A9MGR001",
    "staffId": "usr_01HQ8Z9K3M2N4P5Q6R7S8T9U",
    "amountPaise": 1850000,
    "remarks": "Closing handover — MG Road counter",
    "initiator": "STAFF",
    "status": "PENDING",
    "submittedAt": "2026-09-17T18:30:00.000Z",
    "auditEventId": "aud_01HQ8Z9AUD002",
    "balance": {
      "cashCollectedPaise": 2500000,
      "cashInHandPaise": 0,
      "cashPendingAcceptancePaise": 1850000,
      "collectedPaise": 2500000,
      "handedOverPaise": 650000,
      "adjustmentPaise": 0
    }
  }
}
```

**Response (422)** when amount exceeds cash in hand:

```json
{
  "success": false,
  "error": {
    "code": "CASH_HANDOVER_AMOUNT_EXCEEDS_BALANCE",
    "message": "The handover exceeds this staff member's cash-in-hand balance.",
    "details": {
      "cashInHandPaise": 500000
    }
  }
}
```

### `POST /api/v1/staff/cash/handovers/:handoverId/cancel`

**Request:** no body (idempotent).

**Response (200):**

```json
{
  "success": true,
  "data": {
    "_id": "csh_01HQ8Z9HO001",
    "staffId": "usr_01HQ8Z9K3M2N4P5Q6R7S8T9U",
    "amountPaise": 1850000,
    "status": "CANCELLED",
    "reason": "Cancelled by staff",
    "auditEventId": "aud_01HQ8Z9AUD003"
  }
}
```

---

## Gold rate

| Method | Path | Notes |
|--------|------|--------|
| GET | `/staff/gold-rate/current` | Required before gold-weight **Collect payment** UI |

Missing rate for today → **`GOLD_RATE_NOT_SET`** on gold payment — block submit and show “Rate not set for today”.

### `GET /api/v1/staff/gold-rate/current`

**Response (200):**

```json
{
  "success": true,
  "data": {
    "_id": "grt_01HQ8Z9RATE001",
    "tenantId": "tnt_01HQ7A2B3C4D5E6F7G8H9J",
    "branchId": "brn_01HQ7A9MGR001",
    "ratePerGramPaise": 724000,
    "effectiveDate": "2026-09-17",
    "purity": "22K"
  }
}
```

---

## Profile

| Method | Path | Notes |
|--------|------|--------|
| GET | `/staff/profile` | **Account** screen — user row (no password hash) |

### `GET /api/v1/staff/profile`

**Response (200):**

```json
{
  "success": true,
  "data": {
    "_id": "usr_01HQ8Z9K3M2N4P5Q6R7S8T9U",
    "type": "TENANT_USER",
    "tenantId": "tnt_01HQ7A2B3C4D5E6F7G8H9J",
    "branchId": "brn_01HQ7A9MGR001",
    "role": "COLLECTION_AGENT",
    "name": "Vijay Field",
    "mobile": "9847012352",
    "status": "ACTIVE",
    "permissions": ["CUSTOMER_READ", "SCHEME_READ", "PAYMENT_READ", "PAYMENT_RECORD", "CASH_READ", "CASH_HANDOVER", "GOLD_RATE_READ"]
  }
}
```

---

## Error codes (collection agent UI)

| Code | When | UI action |
|------|------|-----------|
| `UNAUTHENTICATED` / `TOKEN_EXPIRED` | Missing or expired access token | Refresh via `/auth/refresh`; else login |
| `VALIDATION_FAILED` | Body/query validation | Show field errors from `details[]` |
| `PAYMENT_POSITION_CHANGED` | Stale payable quote | Re-fetch payable-range |
| `GOLD_RATE_NOT_SET` | Gold payment when no rate for business day | Block collect; show rate message |
| `HANDOVER_NOT_CANCELLABLE` | Cancel non-pending handover | Refresh handover list |
| `FORBIDDEN` | Wrong role on admin-only path (should not occur if app stays in scope) | — |

**Example error (409 payment stale quote):**

```json
{
  "success": false,
  "error": {
    "code": "PAYMENT_POSITION_CHANGED",
    "message": "The payable position changed. Request a fresh quote.",
    "details": {
      "positionVersion": 8,
      "maxPayablePaise": 120000
    },
    "traceId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  }
}
```

---

## P1.5 (not required for V1)

- Push notifications (FCM) for handover accepted/rejected
- Offline queue / sync for rural connectivity
- QR scan to open customer (deep link by customer id)

---

## Appendix A — Cash collection sequence

```text
Agent login (POST /auth/login) — role COLLECTION_AGENT
    → GET /staff/cash/summary (Home)
Search (GET /staff/customers?q=)
    → GET /staff/customers/:id
    → GET /staff/schemes/:schemeId/payable-range
    → [gold] GET /staff/gold-rate/current
    → POST /staff/payments (mode=CASH)
End of route
    → POST /staff/cash/handovers
Manager (admin panel, not this app)
    → POST /admin/cash/handovers/:id/accept
```

---

## Appendix B — DTO notes

| Surface | Notes |
|---------|--------|
| **Payable range** | Same fields as admin: `minPaise`, `maxPaise`, `suggestedPaise`, `incrementPaise`, `positionVersion`, `targetCycle`, flexible phase flags |
| **Payment record (201)** | `_id`, `schemeId`, `customerId`, `receiptNumber`, `amountPaise`, `mode`, `status`, `source: STAFF_APP`, `paidAt`, optional `goldAccrual` on gold plans |
| **Handover** | `_id`, `staffId`, `amountPaise`, `initiator: STAFF`, `status: PENDING\|ACCEPTED\|REJECTED\|DISCREPANCY`, timestamps |
| **Collection summary** | `{ amountPaise, count, byMode[] }` per date scope |

---

## Appendix C — Route inventory (collection agent app)

**Handlers:** `src/routes/staff.routes.js`, `src/routes/auth.routes.js`, `src/routes/index.js` (`authenticate`, `requireSubject("TENANT_USER")`, `tenantScope`).

| # | Method | Path | UI |
|---|--------|------|-----|
| 1 | GET | `/health` | — |
| 2 | GET | `/health/ready` | — |
| 3 | POST | `/api/v1/auth/login` | Login |
| 4 | POST | `/api/v1/auth/refresh` | Session |
| 5 | POST | `/api/v1/auth/logout` | Account |
| 6 | GET | `/api/v1/auth/me` | Account / Home header |
| 7 | POST | `/api/v1/auth/change-password` | Account |
| 8 | GET | `/api/v1/auth/devices` | Optional sessions list |
| 9 | GET | `/api/v1/staff/customers` | Collect → Search |
| 10 | GET | `/api/v1/staff/customers/check-mobile` | Collect → Search |
| 11 | GET | `/api/v1/staff/customers/:customerId` | Customer detail |
| 12 | GET | `/api/v1/staff/schemes/:schemeId` | Collect payment |
| 13 | GET | `/api/v1/staff/schemes/:schemeId/payable-range` | Collect payment |
| 14 | GET | `/api/v1/staff/schemes/:schemeId/passbook` | Optional ledger |
| 15 | POST | `/api/v1/staff/payments` | Collect payment |
| 16 | GET | `/api/v1/staff/payments` | History → Collections |
| 16a | GET | `/api/v1/staff/payments/:paymentId` | Collection detail |
| 16b | GET | `/api/v1/staff/payments/:paymentId/receipt` | PDF receipt download |
| 17 | GET | `/api/v1/staff/collections/summary` | Home (optional) |
| 18 | GET | `/api/v1/staff/cash/summary` | Home |
| 19 | GET | `/api/v1/staff/cash/collections` | History → Collections (cash-only) |
| 20 | POST | `/api/v1/staff/cash/handovers` | Submit cash |
| 21 | GET | `/api/v1/staff/cash/handovers` | History → Submissions |
| 22 | GET | `/api/v1/staff/cash/handovers/:handoverId` | Submission detail |
| 23 | POST | `/api/v1/staff/cash/handovers/:handoverId/cancel` | Cancel pending |
| 24 | GET | `/api/v1/staff/gold-rate/current` | Collect (gold) / Home chip |
| 25 | GET | `/api/v1/staff/profile` | Account |

**Total: 27** routes used by the collection agent V1 UI (+ health for ops). Other `/staff/*` routes are for full staff builds only.

**Payload examples:** [Appendix D](#appendix-d--complete-request--response-reference) (`#` = Appendix C).

---

## Appendix D — Complete request / response reference

**Collection agent V1 only** — `#` matches [Appendix C](#appendix-c--route-inventory-collection-agent-app).

Legend: **GET** — no body unless noted. Mutating routes: send **`X-Idempotency-Key`**. All `/staff/*` and `/auth/*` (except login/refresh) require **`Authorization: Bearer <accessToken>`**.

### 1. `GET /health`

**Response (200):**

```json
{
  "status": "ok",
  "timestamp": "2026-09-17T06:15:00.000Z"
}
```

### 2. `GET /health/ready`

**Response (200):**

```json
{
  "database": "ready",
  "queue": "ready"
}
```

### 3. `POST /api/v1/auth/login`

See [Auth login](#post-apiv1authlogin).

### 4. `POST /api/v1/auth/refresh`

See [Auth refresh](#post-apiv1authrefresh).

### 5. `POST /api/v1/auth/logout`

See [Auth logout](#post-apiv1authlogout).

### 6. `GET /api/v1/auth/me`

**Request:** none.

**Response (200):**

```json
{
  "success": true,
  "data": {
    "_id": "usr_01HQ8Z9K3M2N4P5Q6R7S8T9U",
    "type": "TENANT_USER",
    "tenantId": "tnt_01HQ7A2B3C4D5E6F7G8H9J",
    "branchId": "brn_01HQ7KOCHI002",
    "role": "COLLECTION_AGENT",
    "name": "Vijay Field",
    "mobile": "9847012352",
    "status": "ACTIVE",
    "permissions": ["CUSTOMER_READ", "SCHEME_READ", "PAYMENT_READ", "PAYMENT_RECORD", "CASH_READ", "CASH_HANDOVER", "GOLD_RATE_READ"],
    "mustSetPassword": false
  }
}
```

### 7. `POST /api/v1/auth/change-password`

**Request:**

```json
{
  "currentPassword": "Swarna@2026",
  "newPassword": "Swarna@2027!"
}
```

**Response (200):**

```json
{
  "success": true,
  "data": {
    "passwordChanged": true,
    "sessionsRevoked": true
  }
}
```

### 8. `GET /api/v1/auth/devices`

**Request:** none.

**Response (200):**

```json
{
  "success": true,
  "data": [
    {
      "deviceId": "staff-pixel-8-001",
      "platform": "android",
      "appVersion": "1.0.0",
      "lastUsedAt": "2026-09-17T11:00:00.000Z",
      "expiresAt": "2027-09-17T11:00:00.000Z"
    }
  ]
}
```

### 9. `GET /api/v1/staff/customers`

See [Customer list](#get-apiv1staffcustomersq9847limit20).

### 10. `GET /api/v1/staff/customers/check-mobile`

See [Check mobile](#get-apiv1staffcustomerscheck-mobilemobile2b919847654321).

### 11. `GET /api/v1/staff/customers/:customerId`

**Request:** path `customerId`. **Query:** none.

**Response (200):**

```json
{
  "success": true,
  "data": {
    "_id": "cus_01HQ8Z9CUS001",
    "tenantId": "tnt_01HQ7A2B3C4D5E6F7G8H9J",
    "branchId": "brn_01HQ7A9MGR001",
    "customerNumber": "C000412",
    "name": "Anjali Menon",
    "mobile": "+919847654321",
    "email": "anjali@example.com",
    "status": "ACTIVE",
    "passbookNumber": "MGR/2026/00412",
    "kyc": { "status": "VERIFIED", "type": "AADHAAR", "numberMasked": "XXXX XXXX 1234" },
    "nominee": { "name": "Raj Menon", "relationship": "SPOUSE" },
    "version": 3
  }
}
```

(Customer 360 shape from `customer360` — list **active schemes** on this payload for the collect UI.)

### 12. `GET /api/v1/staff/schemes/:schemeId`

**Request:** path `schemeId`.

**Response (200):**

```json
{
  "success": true,
  "data": {
    "_id": "sch_01HQ8Z9ENR000456",
    "enrollmentNumber": "ENR-0000456",
    "customerId": "cus_01HQ8Z9CUS001",
    "planId": "spl_01HQ8ZAKSHAYA12",
    "status": "ACTIVE",
    "paymentPattern": "FIXED",
    "startDate": "2026-01-17",
    "maturityDate": "2027-01-17",
    "installmentAmountPaise": 250000,
    "installments": [
      { "number": 1, "dueDate": "2026-02-17", "amountPaise": 250000, "paidPaise": 250000, "status": "PAID" },
      { "number": 2, "dueDate": "2026-03-17", "amountPaise": 250000, "paidPaise": 0, "status": "DUE" }
    ],
    "positionVersion": 8,
    "version": 13
  }
}
```

### 13. `GET /api/v1/staff/schemes/:schemeId/payable-range`

See [Payable range](#get-apiv1staffschemesschemeidpayable-range).

### 14. `GET /api/v1/staff/schemes/:schemeId/passbook`

**Request:** none.

**Response (200):**

```json
{
  "success": true,
  "data": {
    "scheme": {
      "_id": "sch_01HQ8Z9ENR000456",
      "enrollmentNumber": "ENR-0000456",
      "status": "ACTIVE"
    },
    "ledger": [
      {
        "_id": "led_01HQ8Z9LDG001",
        "type": "INSTALLMENT_PAYMENT",
        "sequence": 1,
        "amountPaise": 250000,
        "weightMg": 345,
        "cycle": "2026-09",
        "effectiveAt": "2026-09-17T11:05:22.000Z",
        "paymentId": "pay_01HQ8Z9PAY001234"
      }
    ]
  }
}
```

### 15. `POST /api/v1/staff/payments`

See [Record payment](#post-apiv1staffpayments).

### 16. `GET /api/v1/staff/payments`

**Query:** `cursor?`, `limit?`, `from?`, `to?`, `mode?`, `includeSummary=true?`, `sort=paidAt:desc?`

**Response (200):**

```json
{
  "success": true,
  "data": [
    {
      "_id": "pay_01HQ8Z9PAY001234",
      "receiptNumber": "RCP-2026-0001234",
      "amountPaise": 250000,
      "amount": { "amountPaise": 250000 },
      "mode": "CASH",
      "status": "SUCCESS",
      "source": "STAFF_APP",
      "paidAt": "2026-09-17T11:05:22.000Z",
      "customer": { "_id": "cus_01HQ8Z9CUS001", "id": "cus_01HQ8Z9CUS001", "name": "Anjali Menon" },
      "scheme": { "_id": "sch_01HQ8Z9ENR000456", "id": "sch_01HQ8Z9ENR000456", "enrollmentNumber": "ENR-0000456" },
      "collectedBy": { "_id": "usr_01HQ8Z9K3M2N4P5Q6R7S8T9U", "name": "Vijay Field" },
      "goldAccrual": null
    }
  ],
  "meta": { "nextCursor": null, "hasMore": false, "limit": 20 }
}
```

### 16a. `GET /api/v1/staff/payments/:paymentId`

**Access:** Collection agents only see payments where **`collectedBy`** matches their user id (same scope as list).

**Response (200):** Single payment object — same enriched shape as list rows (**#16**), including `customer`, `scheme`, `branch`, `collectedBy`, `goldAccrual`, `amount`.

**Errors:** `404` if not found or out of scope.

### 16b. `GET /api/v1/staff/payments/:paymentId/receipt`

**Response (200):** `Content-Type: application/pdf` — receipt for the payment (same access rules as **16a**).

### 17. `GET /api/v1/staff/collections/summary`

See [Collections summary](#get-apiv1staffcollectionssummaryfrom2026-09-17to2026-09-17).

### 18. `GET /api/v1/staff/cash/summary`

See [`GET /api/v1/staff/cash/summary`](#get-apiv1staffcashsummary).

### 19. `GET /api/v1/staff/cash/collections`

**Query:** same as **`GET /staff/payments`** with cash filter applied server-side (`mode=CASH`).

**Response (200):** same list shape as **#16**, typically all rows `mode: "CASH"`.

### 20. `POST /api/v1/staff/cash/handovers`

See [Create handover](#post-apiv1staffcashhandovers).

### 21. `GET /api/v1/staff/cash/handovers`

**Query:** `cursor?`, `limit?`, `status?`, `from?`, `to?`

**Response (200):**

```json
{
  "success": true,
  "data": [
    {
      "_id": "csh_01HQ8Z9HO001",
      "staffId": "usr_01HQ8Z9K3M2N4P5Q6R7S8T9U",
      "branchId": "brn_01HQ7A9MGR001",
      "amountPaise": 1850000,
      "status": "PENDING",
      "initiator": "STAFF",
      "remarks": "Closing handover",
      "submittedAt": "2026-09-17T18:30:00.000Z"
    },
    {
      "_id": "csh_01HQ8Z9HO000",
      "amountPaise": 650000,
      "status": "ACCEPTED",
      "submittedAt": "2026-09-16T18:00:00.000Z",
      "settledAt": "2026-09-16T19:15:00.000Z"
    }
  ],
  "meta": { "nextCursor": null, "hasMore": false, "limit": 20 }
}
```

### 22. `GET /api/v1/staff/cash/handovers/:handoverId`

**Request:** path `handoverId` (must belong to auth staff).

**Response (200):**

```json
{
  "success": true,
  "data": {
    "_id": "csh_01HQ8Z9HO001",
    "tenantId": "tnt_01HQ7A2B3C4D5E6F7G8H9J",
    "branchId": "brn_01HQ7A9MGR001",
    "staffId": "usr_01HQ8Z9K3M2N4P5Q6R7S8T9U",
    "amountPaise": 1850000,
    "acceptedAmountPaise": null,
    "discrepancyPaise": null,
    "status": "PENDING",
    "initiator": "STAFF",
    "remarks": "Closing handover",
    "submittedAt": "2026-09-17T18:30:00.000Z",
    "settledAt": null,
    "branch": { "_id": "brn_01HQ7A9MGR001", "name": "Kochi Main", "code": "KOC" },
    "settledBy": null,
    "timeline": [
      { "event": "SUBMITTED", "at": "2026-09-17T18:30:00.000Z", "by": "Vijay Field", "note": "Closing handover" },
      { "event": "AWAITING_ACCEPTANCE", "at": "2026-09-17T18:30:00.000Z", "by": "Kochi Main" }
    ]
  }
}
```

### 23. `POST /api/v1/staff/cash/handovers/:handoverId/cancel`

See [Cancel handover](#post-apiv1staffcashhandovershandoveridcancel).

### 24. `GET /api/v1/staff/gold-rate/current`

See [Gold rate](#get-apiv1staffgold-ratecurrent).

### 25. `GET /api/v1/staff/profile`

See [Profile](#get-apiv1staffprofile).

---

*Implementation: `src/routes/staff.routes.js`, `src/services/cash.service.js`, `src/services/payment.service.js`, `src/services/scheme.service.js`, `docs/contract-routes.lock`.*
