# SwarnaGrow Collection Staff / Agent API Guide (Flutter)

**Audience:** Flutter developers building the **collection agent** mobile app  
**Role:** `TENANT_USER` with `role: "COLLECTION_AGENT"` and a non-null `branchId`  
**API prefix:** `/api/v1`  
**Base URL (prod):** `https://api.swarnagrow.com`  
**Base URL (local):** `http://localhost:4000`  

Canonical copies: `swarnagrow-backend/docs/FLUTTER_STAFF_AGENT_API_GUIDE.md` and `SwarnaGrow-Tenant-Admin/docs/FLUTTER_STAFF_AGENT_API_GUIDE.md`.

Related: [`API_CONTRACT_STAFF.md`](./API_CONTRACT_STAFF.md) (route inventory + more examples) · [`FLUTTER_PHONEPE_INTEGRATION.md`](./FLUTTER_PHONEPE_INTEGRATION.md) (customer PhonePe SDK — agent QR uses **hosted** checkout URL shown as QR).

---

## 0. What this app can do

| Capability | Always on | Tenant flag |
|---|---|---|
| Login / refresh / logout / profile / change password | Yes | — |
| Search customers, open detail, list schemes | Yes | — |
| Collect with **CASH / UPI / CARD / BANK_TRANSFER** | Yes | — |
| Create **30-min payment link** (share) | Yes | Platform `onlinePayments` + jeweller payments enabled |
| **Show PhonePe QR** (customer scans → auto receipt) | Yes | Same as payment links |
| Cash in hand + handover to branch | Yes | — |
| Collection history + summary report | Yes | — |
| Gold rate for gold-weight schemes | Yes | — |
| Register new customer | Optional | `operations.agentCanRegisterCustomers` |
| Capture KYC documents (upload + submit) | Optional | Same flag (+ KYC permission grant) |
| Enrol customer in a scheme | Optional | `operations.agentCanEnrolSchemes` |
| KYC required before enrol | Tenant setting | `operations.kycMandatory` (or legacy `settings.requireKycForEnrolment`) |

Read `user.agentCapabilities` and `user.permissions` from login / `GET /auth/me` / `GET /staff/profile` and hide screens the agent cannot use.

---

## 1. Transport conventions

### Headers

```http
Content-Type: application/json
Authorization: Bearer <accessToken>
X-Idempotency-Key: <8-to-128-char-unique-key>   # every POST/PUT/PATCH/DELETE marked idempotent
X-Platform: android                               # android | ios | web
X-App-Version: 1.0.0
```

Generate a **new** idempotency key per logical user action. Reuse the same key only when retrying the **same** action after timeout/network failure.

### Success envelopes

```json
{ "success": true, "data": {} }
```

Paginated list:

```json
{
  "success": true,
  "data": [],
  "meta": { "nextCursor": "cursor_abc", "hasMore": true, "limit": 20, "total": 120 }
}
```

### Error envelope

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Please correct the highlighted fields.",
    "details": [{ "field": "body.amountPaise", "message": "Expected number" }],
    "traceId": "trace_..."
  }
}
```

Branch on `error.code`, never English `message`. Log `traceId` for support.

### Money, weight, dates

- Amounts are integer **paise**: ₹5,000 = `500000`.
- Gold weights are integer **mg**: 1 g = `1000`.
- Dates: `YYYY-MM-DD` (IST business day). Timestamps: ISO-8601.
- Cycles (flexible): `YYYY-MM`.

### Auth refresh pattern

1. Call protected API → `401` / `TOKEN_EXPIRED` / `UNAUTHENTICATED`
2. `POST /auth/refresh` with stored `refreshToken`
3. Persist new tokens; retry original request **once**
4. If refresh fails → clear session → login screen

### Platform gate

Staff routes require jeweller flag **`staffAppEnabled`**. If disabled: `403` with a capability error — show “Staff app not enabled for this jewellery”.

---

## 2. End-to-end flows

### 2.1 Login → Home

```text
POST /auth/login
  → assert role == COLLECTION_AGENT && branchId != null
  → GET /staff/cash/summary
  → GET /staff/collections/summary?from=YYYY-MM-DD&to=YYYY-MM-DD   (today IST)
  → GET /staff/payments?limit=4&sort=paidAt:desc
  → GET /staff/cash/handovers?status=PENDING
  → (optional) GET /staff/gold-rate/current
```

### 2.2 Collect cash / UPI / card / bank (manual)

```text
GET /staff/customers?q=...
  → GET /staff/customers/:customerId
  → GET /staff/schemes/:schemeId
  → GET /staff/schemes/:schemeId/payable-range
  → [gold] GET /staff/gold-rate/current   (block if missing)
  → POST /staff/payments   (mode CASH|UPI|CARD|BANK_TRANSFER)
  → on 409 PAYMENT_POSITION_CHANGED → re-fetch payable-range → confirm → retry with new version
```

**Only `mode: "CASH"` increases cash in hand.** UPI/card/bank are receipts for audit; they never go into handover balance.

### 2.3 Share payment link (30 minutes)

```text
Refresh payable-range
  → POST /staff/payment-links
  → Share absolute URL: https://<your-portal-host>/pay/<token>
     (or deep-link to customer pay page if you host one)
```

Customer pays on PhonePe; webhook marks payment SUCCESS. Agent history shows it after attribution (`collectedBy` = link creator).

### 2.4 Show PhonePe QR (in-person scan)

```text
Refresh payable-range
  → POST /staff/payment-qr-sessions
  → Show QR of data.qrPayload (PhonePe hosted checkout URL)
  → Poll GET /staff/payment-qr-sessions/:token/status every 3s
  → when poll.paid == true → GET /staff/payments/:paymentId → success receipt UI
  → on poll.failed → dismiss QR, allow retry / manual collect
```

Do **not** open native PhonePe SDK for this flow — the QR encodes the **hosted** checkout URL. Customer’s UPI app / PhonePe page completes payment.

### 2.5 Cash handover

```text
GET /staff/cash/summary
  → max = availableForHandoverPaise
  → POST /staff/cash/handovers
  → status PENDING until branch accepts in admin
  → optional cancel: POST /staff/cash/handovers/:id/cancel while PENDING
```

### 2.6 Register + KYC + enrol (capability-gated)

```text
if agentCapabilities.registerCustomers:
  POST /staff/customers
  if agentCapabilities.kycMandatory:
    POST /staff/uploads/presign (purpose KYC_DOCUMENT)
    PUT bytes to uploadUrl
    POST /staff/uploads/:uploadId/complete
    PUT /staff/customers/:id/kyc
if agentCapabilities.enrolSchemes:
  GET /staff/scheme-plans
  POST /staff/schemes/enrol/validate
  POST /staff/schemes/enrol
```

When KYC is mandatory, enrolment is blocked until KYC status is **`VERIFIED`** (branch verifies after agent submits).

---

## 3. Auth (`/api/v1/auth/*`)

### 3.1 `POST /auth/login`

**Request**

```json
{
  "tenantCode": "KAIRALI",
  "mobile": "9847012352",
  "password": "2026",
  "deviceId": "flutter-pixel-8-001",
  "platform": "android",
  "appVersion": "1.2.0"
}
```

Omit `tenantCode` on first try if the agent may belong to multiple jewelleries.

**Response (200)**

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr_01HQ8Z9K3M2N4P5Q6R7S8T9U",
      "name": "Vijay Field",
      "mobile": "9847012352",
      "role": "COLLECTION_AGENT",
      "tenantId": "tnt_01HQ7A2B3C4D5E6F7G8H9J",
      "branchId": "brn_01HQ7KOCHI002",
      "tenantCode": "KAIRALI",
      "tenantName": "Kairali Savings",
      "branchName": "Kochi Showroom",
      "branchCode": "KOCHI",
      "permissions": [
        "CUSTOMER_READ",
        "SCHEME_READ",
        "PAYMENT_READ",
        "PAYMENT_RECORD",
        "CASH_READ",
        "CASH_HANDOVER",
        "GOLD_RATE_READ"
      ],
      "agentCapabilities": {
        "registerCustomers": true,
        "enrolSchemes": true,
        "kycMandatory": true
      },
      "mustSetPassword": false
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "rt_48charOpaqueToken...",
    "expiresIn": 1800,
    "tokenType": "Bearer"
  }
}
```

`expiresIn` is **seconds**. Persist refresh token in secure storage.

**Response (409) `TENANT_SELECTION_REQUIRED`**

```json
{
  "success": false,
  "error": {
    "code": "TENANT_SELECTION_REQUIRED",
    "message": "Select a jewellery to continue.",
    "details": {
      "tenants": [
        { "tenantCode": "KAIRALI", "displayName": "Kairali Savings", "logoUrl": null }
      ]
    }
  }
}
```

Show picker → retry login with chosen `tenantCode`.

**Gate:** If `role !== "COLLECTION_AGENT"` or `branchId` is null → logout with “This app is for collection agents only”.

### 3.2 `POST /auth/refresh`

```json
{ "refreshToken": "rt_48charOpaqueToken..." }
```

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJ...",
    "refreshToken": "rt_rotated...",
    "expiresIn": 1800,
    "tokenType": "Bearer"
  }
}
```

### 3.3 `POST /auth/logout`

```json
{ "refreshToken": "rt_48charOpaqueToken..." }
```

```json
{ "success": true, "data": { "loggedOut": true } }
```

### 3.4 `GET /auth/me` · `GET /staff/profile`

Same user DTO family as login `user` (id, role, branch, permissions, `agentCapabilities`).

### 3.5 `POST /auth/change-password`

```json
{
  "currentPassword": "2026",
  "newPassword": "Swarna@2027!"
}
```

```json
{ "success": true, "data": { "passwordChanged": true, "sessionsRevoked": true } }
```

After success, force re-login (sessions revoked).

### 3.6 Demo credentials (Kairali)

After `npm run seed:demo` on the backend:

| Field | Value |
|---|---|
| Tenant code | `KAIRALI` |
| Mobile | `9847012352` |
| Password | `2026` |
| User | Vijay Field — Kochi branch |

---

## 4. Home / cash / report

### 4.1 `GET /staff/cash/summary`

**Response**

```json
{
  "success": true,
  "data": {
    "cashCollectedPaise": 2500000,
    "cashInHandPaise": 1850000,
    "cashPendingAcceptancePaise": 400000,
    "availableForHandoverPaise": 1450000,
    "collectedPaise": 2500000,
    "handedOverPaise": 650000,
    "adjustmentPaise": 0
  }
}
```

| Field | Meaning |
|---|---|
| `cashInHandPaise` | Cash custody until branch accepts handovers |
| `cashPendingAcceptancePaise` | Submitted, not yet accepted |
| `availableForHandoverPaise` | Max you may submit now (`cashInHand − pending`, floor 0) |

Only **successful CASH** collections (net of reversals) feed this ledger.

### 4.2 `GET /staff/collections/summary?from=2026-11-11&to=2026-11-11`

Includes **all payment methods** attributed to this agent (manual + QR/link).

```json
{
  "success": true,
  "data": {
    "amountPaise": 1800000,
    "count": 4,
    "byMode": [
      { "mode": "CASH", "label": "Cash in hand", "amountPaise": 500000, "count": 1 },
      { "mode": "UPI", "label": "UPI", "amountPaise": 300000, "count": 1 },
      { "mode": "ONLINE_GATEWAY", "label": "Online payment", "amountPaise": 1000000, "count": 2 }
    ],
    "grossAmountPaise": 1800000,
    "refundOutflowPaise": 0
  }
}
```

Use IST calendar dates for `from` / `to`.

### 4.3 `GET /staff/payments?limit=20&sort=paidAt:desc&from=&to=&cursor=`

Agent-scoped: `collectedBy = me` **or** payments from payment-links / QR sessions this agent created (legacy rows are backfilled on read).

**Response item (enriched)**

```json
{
  "_id": "pay_01HQ...",
  "receiptNumber": "RCP-2026-0000819",
  "amountPaise": 500000,
  "mode": "ONLINE_GATEWAY",
  "status": "SUCCESS",
  "source": "STAFF_APP",
  "paidAt": "2026-11-11T02:28:00.000Z",
  "customer": { "id": "cus_...", "name": "Test", "mobile": "+91..." },
  "scheme": {
    "id": "sch_...",
    "enrollmentNumber": "ENR-0000144",
    "planName": "11+1 Saving Scheme"
  }
}
```

**Mode labels for UI**

| `mode` | Display |
|---|---|
| `CASH` | Cash in hand |
| `UPI` | UPI |
| `CARD` | Card / POS |
| `BANK_TRANSFER` | Bank transfer |
| `ONLINE_GATEWAY` | Online payment (QR / payment link / PhonePe) |

### 4.4 `GET /staff/payments/:paymentId`

Same enriched payment. Use after QR poll succeeds.

### 4.5 `GET /staff/payments/:paymentId/receipt`

Returns **PDF** (`Content-Type: application/pdf`). Save to file / share sheet.

### 4.6 `GET /staff/cash/collections`

Same list handler as payments but **forces `mode=CASH`**. Prefer `/staff/payments` for “all methods” history.

### 4.7 Building “My report” in Flutter

1. `GET /staff/collections/summary?from=&to=` → totals + `byMode`
2. Page `GET /staff/payments?from=&to=&limit=100&cursor=` until `meta.hasMore == false`
3. Bucket rows by **IST** calendar day of `paidAt` for the chart  
   (`DateFormat` / timezone `Asia/Kolkata`, not UTC `substring(0,10)`)

---

## 5. Customers

### 5.1 `GET /staff/customers?q=&cursor=&limit=`

Search name, mobile, customer number, passbook (branch-scoped).

```json
{
  "success": true,
  "data": [
    {
      "_id": "cus_01HQ...",
      "name": "Anjali Menon",
      "mobile": "9847654321",
      "passbookNumber": "KOCHI/2026/00412",
      "kycStatus": "VERIFIED",
      "activeSchemeCount": 1
    }
  ],
  "meta": { "nextCursor": null, "hasMore": false, "limit": 20 }
}
```

### 5.2 `GET /staff/customers/check-mobile?mobile=`

```json
{ "success": true, "data": { "exists": true, "customerId": "cus_..." } }
```

Use before register to avoid duplicates.

### 5.3 `GET /staff/customers/:customerId`

Includes `kyc`, schemes (ids / enrollment numbers / status) for collect / enrol decisions. Prefer scheme ids from this payload when opening collect.

### 5.4 `POST /staff/customers` (capability)

Requires `CUSTOMER_WRITE` (from `agentCapabilities.registerCustomers`).

```json
{
  "name": "Anjali Menon",
  "mobile": "9847654321",
  "passbookNumber": "KOCHI/2026/00412",
  "email": "anjali@example.com",
  "address": "12 MG Road, Kochi"
}
```

`passbookNumber` / `email` optional. Do **not** send `branchId` — server uses the agent’s branch.

**Response (201)** — customer document (`_id`, `name`, `mobile`, `kyc`, `version`, …). Persist `_id` for KYC / enrol.

### 5.5 `PATCH /staff/customers/:customerId` (capability)

Partial update of the same fields; send `expectedVersion` from detail when present.

### 5.6 Nominee (capability write)

- `GET /staff/customers/:id/nominee`
- `PUT /staff/customers/:id/nominee`

```json
{
  "name": "Ravi Menon",
  "relationship": "SPOUSE",
  "mobile": "9847000001",
  "address": "12 MG Road",
  "expectedVersion": 3
}
```

- `DELETE /staff/customers/:id/nominee` (idempotent)

---

## 6. KYC upload + submit (capability)

### 6.1 Presign

`POST /staff/uploads/presign`

```json
{
  "purpose": "KYC_DOCUMENT",
  "fileName": "aadhaar-front.jpg",
  "contentType": "image/jpeg",
  "sizeBytes": 245760
}
```

**Only `KYC_DOCUMENT` is allowed** for staff uploads.

```json
{
  "success": true,
  "data": {
    "uploadId": "upl_01HQ...",
    "uploadUrl": "https://storage.../presigned-put",
    "headers": { "Content-Type": "image/jpeg" },
    "expiresAt": "2026-11-11T08:30:00.000Z"
  }
}
```

### 6.2 Upload bytes

`PUT <uploadUrl>` with raw file bytes and any returned headers.

### 6.3 Complete

`POST /staff/uploads/:uploadId/complete`

```json
{ "sizeBytes": 245760, "checksumSha256": optional }
```

### 6.4 Submit KYC

`PUT /staff/customers/:customerId/kyc`

```json
{
  "type": "AADHAAR",
  "number": "123456789012",
  "frontUploadId": "upl_front",
  "backUploadId": "upl_back"
}
```

Status becomes `SUBMITTED` until branch verifies → `VERIFIED`.

Allowed `type` values: jeweller `kycAllowedTypes` (typically `AADHAAR`, `PAN`, `PASSPORT`, `VOTER_ID`, `DRIVING_LICENSE`).

---

## 7. Schemes & enrolment

### 7.1 `GET /staff/scheme-plans` (capability enrol)

List plans available for enrolment.

### 7.2 `POST /staff/schemes/enrol/validate` · `POST /staff/schemes/enrol`

```json
{
  "customerId": "cus_...",
  "planId": "spl_...",
  "installmentAmountPaise": 250000,
  "firstInstallmentMode": "START_NEXT_CYCLE"
}
```

| Field | Values / notes |
|---|---|
| `firstInstallmentMode` | `COLLECT_NOW` \| `START_NEXT_CYCLE` |
| `firstInstallmentAction` | Optional when collecting now: `RECORD_MANUAL_PAYMENT` \| `CREATE_PAYMENT_LINK` |
| `installmentAmountPaise` | Required for flexible / slab plans as dictated by plan rules |
| `payment` | Optional object when `COLLECT_NOW` + manual — mirror staff payment fields |

**Flow:** call **validate** (no idempotency required) → show blockers/warnings → **enrol** with a **new** `X-Idempotency-Key`.

**Validate response** includes `ok` / blockers (e.g. KYC not verified when mandatory). **Enrol 201** returns the new scheme (`_id`, `enrollmentNumber`, status, …).

### 7.3 `GET /staff/schemes/:schemeId`

Scheme detail (enrollment number, pattern, value basis, installments, versions).

### 7.4 `GET /staff/schemes/:schemeId/payable-range?targetCycle=`

**Always call immediately before any collect / link / QR.**

Fixed:

```json
{
  "success": true,
  "data": {
    "model": "FIXED",
    "payable": true,
    "installmentNumber": 3,
    "minPayablePaise": 250000,
    "maxPayablePaise": 250000,
    "suggestedPaise": 250000,
    "expectedVersion": 12,
    "positionVersion": 12
  }
}
```

Flexible:

```json
{
  "success": true,
  "data": {
    "model": "FLEXIBLE",
    "phase": "CAPPED",
    "payable": true,
    "targetCycle": "2026-11",
    "minPayablePaise": 10000,
    "maxPayablePaise": 150000,
    "suggestedPaise": 50000,
    "paymentIncrementPaise": 100,
    "positionVersion": 7,
    "targetCycleOptions": [
      { "cycle": "2026-11", "label": "Nov 2026", "isCurrentCycle": true }
    ]
  }
}
```

Send back:

- Fixed → `expectedVersion` (or `expectedPositionVersion` if returned)
- Flexible → `expectedPositionVersion` / `positionVersion` + `targetCycle` when capped

### 7.5 `GET /staff/schemes/:schemeId/passbook`

`{ scheme, ledger[] }` for recent entries on collect screen.

### 7.6 `GET /staff/gold-rate/current`

```json
{
  "success": true,
  "data": {
    "_id": "gr_...",
    "ratePerGramPaise": 724000,
    "effectiveDate": "2026-11-11",
    "purity": "22K"
  }
}
```

If null / not found → **block gold-weight collection**. Preview weight:

`floor(amountPaise * 1000 / ratePerGramPaise)` — display only; trust receipt `weightMg`.

---

## 8. Record collection (manual)

### `POST /staff/payments`

**Headers:** `Authorization`, `X-Idempotency-Key`

**Cash in hand example**

```json
{
  "schemeId": "sch_...",
  "amountPaise": 500000,
  "mode": "CASH",
  "expectedPositionVersion": 7,
  "targetCycle": "2026-11",
  "remarks": "Collected on route"
}
```

**UPI / card / bank example**

```json
{
  "schemeId": "sch_...",
  "amountPaise": 500000,
  "mode": "UPI",
  "expectedPositionVersion": 7,
  "targetCycle": "2026-11",
  "reference": "UPI/123456",
  "remarks": "Customer paid via GPay"
}
```

| Field | Required | Notes |
|---|---|---|
| `schemeId` | yes | |
| `amountPaise` | yes | Must be within payable-range min/max (and increment) |
| `mode` | yes | `CASH` \| `UPI` \| `CARD` \| `BANK_TRANSFER` only |
| `expectedPositionVersion` / `positionVersion` | flexible | From payable-range |
| `expectedVersion` | fixed | From payable-range (`expectedVersion` / `positionVersion`) |
| `targetCycle` | flexible capped | `YYYY-MM` from payable-range options |
| `reference` | no | UPI ref / card RR / bank UTR |
| `remarks` | no | |

**Only `CASH` increases cash in hand.** Other modes appear in history + report but not in handover balance.

**Response (201)**

```json
{
  "success": true,
  "data": {
    "_id": "pay_01HQ...",
    "receiptNumber": "RCP-2026-0000819",
    "schemeId": "sch_...",
    "customerId": "cus_...",
    "amountPaise": 500000,
    "allocatedAmountPaise": 500000,
    "mode": "CASH",
    "status": "SUCCESS",
    "source": "STAFF_APP",
    "collectedBy": "usr_...",
    "weightMg": 0,
    "ratePerGramPaise": 0,
    "targetCycle": "2026-11",
    "paidAt": "2026-11-11T02:28:00.000Z",
    "reference": null,
    "remarks": "Collected on route"
  }
}
```

Gold-weight schemes may return non-zero `weightMg` / `ratePerGramPaise`.

**409 `PAYMENT_POSITION_CHANGED`** → refresh payable-range, update form, **new** idempotency key for the new attempt.

---

## 9. Payment link (share)

### `POST /staff/payment-links`

```json
{
  "schemeId": "sch_...",
  "amountPaise": 500000,
  "expectedPositionVersion": 7,
  "targetCycle": "2026-11",
  "expiresInMinutes": 30
}
```

```json
{
  "success": true,
  "data": {
    "id": "plink_...",
    "token": "tok_32chars...",
    "url": "/pay/tok_32chars...",
    "status": "CREATED",
    "expiresAt": "2026-11-11T08:45:00.000Z",
    "paymentIntentId": "pi_...",
    "positionVersion": 8
  }
}
```

Build share URL with your hosted portal origin, e.g. `https://app.swarnagrow.com/pay/<token>`.

---

## 10. PhonePe QR collect (Show QR)

### 10.1 `POST /staff/payment-qr-sessions`

Same body as payment-links, plus optional `redirectUrl`.

```json
{
  "schemeId": "sch_...",
  "amountPaise": 500000,
  "expectedPositionVersion": 7,
  "expiresInMinutes": 30,
  "redirectUrl": "https://app.swarnagrow.com/pay/return"
}
```

| Field | Notes |
|---|---|
| `expiresInMinutes` | Optional; max **30** |
| `redirectUrl` | Absolute HTTPS URL; origin must be in API CORS allowlist. If omitted, server uses request `Origin` / `Referer` → `{origin}/pay/{token}`. **Flutter native apps should always send an allowlisted `redirectUrl`** (no browser Origin). |

**Response (201)**

```json
{
  "success": true,
  "data": {
    "id": "plink_...",
    "token": "tok_...",
    "url": "/pay/tok_...",
    "status": "ACTIVE",
    "expiresAt": "2026-11-11T08:45:00.000Z",
    "amountPaise": 500000,
    "paymentId": "pay_...",
    "gatewayUrl": "https://mercury.phonepe.com/transact/pg?token=...",
    "qrPayload": "https://mercury.phonepe.com/transact/pg?token=...",
    "providerOrderId": "OMO...",
    "paymentIntentId": "pi_...",
    "positionVersion": 8
  }
}
```

**Flutter:** render QR from `qrPayload` (prefer over `gatewayUrl` if both present). Keep screen open while polling.

### 10.2 `GET /staff/payment-qr-sessions/:linkToken/status`

Poll every **3 seconds** (or `retryAfterSeconds` when present).

```json
{
  "success": true,
  "data": {
    "linkId": "plink_...",
    "status": "PROCESSING",
    "processing": true,
    "paid": false,
    "failed": false,
    "receipt": null,
    "retryAfterSeconds": 3
  }
}
```

When paid:

```json
{
  "success": true,
  "data": {
    "linkId": "plink_...",
    "status": "PAID",
    "processing": false,
    "paid": true,
    "failed": false,
    "receipt": {
      "paymentId": "pay_...",
      "receiptNumber": "RCP-2026-0000820",
      "paidAt": "2026-11-11T02:33:10.000Z"
    },
    "retryAfterSeconds": null
  }
}
```

Then `GET /staff/payments/{paymentId}` for full receipt UI. Mode will be `ONLINE_GATEWAY`.

**Attribution:** QR / link payments are credited to the creating agent (`collectedBy`), so they appear in History and Report.

---

## 11. Cash handovers

### `POST /staff/cash/handovers`

**Headers:** `Authorization`, `X-Idempotency-Key`

```json
{ "amountPaise": 1450000, "remarks": "End of route" }
```

Must be `≤ availableForHandoverPaise` from cash summary.

**Response (201)**

```json
{
  "success": true,
  "data": {
    "_id": "handover_...",
    "amountPaise": 1450000,
    "status": "PENDING",
    "remarks": "End of route",
    "submittedAt": "2026-11-11T09:00:00.000Z",
    "balance": {
      "cashInHandPaise": 1850000,
      "cashPendingAcceptancePaise": 1450000,
      "availableForHandoverPaise": 400000
    }
  }
}
```

Pending handovers do **not** reduce `cashInHandPaise`; they reduce `availableForHandoverPaise`.

### `GET /staff/cash/handovers?status=&cursor=&limit=`

Filter `status=PENDING` for home “pending submit” list.

### `GET /staff/cash/handovers/:handoverId`

Single handover detail (status, amounts, settle reason when settled).

### `POST /staff/cash/handovers/:handoverId/cancel`

Idempotent. Only while `PENDING`. After cancel, refresh cash summary.

Statuses: `PENDING` | `ACCEPTED` | `REJECTED` | `DISCREPANCY` | `CANCELLED`.

---

## 12. Notifications & FCM

### `GET /staff/notifications`

Operational reminders (`PAYMENT_DUE`, `PAYMENT_OVERDUE`) for the agent’s branch.

### `POST /staff/devices/fcm-token`

```json
{
  "fcmToken": "<fcm-registration-token>",
  "deviceId": "flutter-pixel-8-001",
  "platform": "android",
  "appVersion": "1.2.0"
}
```

### `DELETE /staff/devices/fcm-token`

```json
{ "deviceId": "flutter-pixel-8-001" }
```

---

## 13. Other staff routes (optional)

| Method | Path | Notes |
|---|---|---|
| GET | `/staff/home` · `/staff/dashboard/summary` | Staff home aggregate |
| GET | `/staff/dues` · `/staff/overdues` | Needs `REPORT_READ` — not in default agent role |
| GET | `/staff/grievances` · `.../messages` | Needs grievance permissions — not default agent |

Default `COLLECTION_AGENT` permissions do **not** include dues/grievances unless granted separately.

---

## 14. Error codes (agent UI)

| Code | When | Action |
|---|---|---|
| `UNAUTHENTICATED` / `TOKEN_EXPIRED` | Bad/expired access | Refresh; else login |
| `TENANT_SELECTION_REQUIRED` | Multi-tenant mobile | Show jewellery picker |
| `VALIDATION_FAILED` | Bad body/query | Show `details[]` |
| `PAYMENT_POSITION_CHANGED` | Stale quote | Re-fetch payable-range |
| `GOLD_RATE_NOT_SET` | Gold collect without rate | Block submit |
| `CASH_HANDOVER_AMOUNT_EXCEEDS_BALANCE` | Handover too large | Refresh cash summary |
| `HANDOVER_NOT_CANCELLABLE` | Cancel non-pending | Refresh handover |
| `PAYMENT_LINK_BUSY` | Concurrent initiate | Retry QR/link shortly |
| `UPLOAD_PURPOSE_FORBIDDEN` | Non-KYC upload purpose | Use `KYC_DOCUMENT` only |
| `FORBIDDEN` | Missing permission / capability | Hide feature |

---

## 15. Route inventory (Flutter agent)

| # | Method | Path | Idempotent | Notes |
|---|---|---|---|---|
| 1 | POST | `/auth/login` | no | |
| 2 | POST | `/auth/refresh` | no | |
| 3 | POST | `/auth/logout` | no | |
| 4 | GET | `/auth/me` | no | |
| 5 | POST | `/auth/change-password` | no | |
| 6 | GET | `/auth/devices` | no | optional |
| 7 | GET | `/staff/profile` | no | |
| 8 | GET | `/staff/cash/summary` | no | |
| 9 | GET | `/staff/collections/summary` | no | |
| 10 | GET | `/staff/gold-rate/current` | no | |
| 11 | GET | `/staff/customers` | no | |
| 12 | GET | `/staff/customers/check-mobile` | no | |
| 13 | GET | `/staff/customers/:id` | no | |
| 14 | POST | `/staff/customers` | yes | capability |
| 15 | PATCH | `/staff/customers/:id` | yes | capability |
| 16 | POST | `/staff/uploads/presign` | yes | KYC |
| 17 | POST | `/staff/uploads/:id/complete` | yes | KYC |
| 18 | PUT | `/staff/customers/:id/kyc` | yes | KYC |
| 19 | GET/PUT/DELETE | `/staff/customers/:id/nominee` | write yes | capability |
| 20 | GET | `/staff/scheme-plans` | no | enrol |
| 21 | POST | `/staff/schemes/enrol/validate` | no | enrol |
| 22 | POST | `/staff/schemes/enrol` | yes | enrol |
| 23 | GET | `/staff/schemes/:id` | no | |
| 24 | GET | `/staff/schemes/:id/payable-range` | no | |
| 25 | GET | `/staff/schemes/:id/passbook` | no | |
| 26 | POST | `/staff/payments` | yes | all manual modes |
| 27 | GET | `/staff/payments` | no | all modes |
| 28 | GET | `/staff/payments/:id` | no | |
| 29 | GET | `/staff/payments/:id/receipt` | no | PDF |
| 30 | POST | `/staff/payment-links` | yes | share |
| 31 | POST | `/staff/payment-qr-sessions` | yes | Show QR |
| 32 | GET | `/staff/payment-qr-sessions/:token/status` | no | poll |
| 33 | GET | `/staff/cash/collections` | no | cash-only list |
| 34 | POST | `/staff/cash/handovers` | yes | |
| 35 | GET | `/staff/cash/handovers` | no | |
| 36 | GET | `/staff/cash/handovers/:id` | no | |
| 37 | POST | `/staff/cash/handovers/:id/cancel` | yes | |
| 38 | GET | `/staff/notifications` | no | |
| 39 | POST | `/staff/devices/fcm-token` | yes | |
| 40 | DELETE | `/staff/devices/fcm-token` | no | |

---

## 16. Flutter implementation checklist

- [ ] Secure storage for access + refresh tokens  
- [ ] Single-flight refresh on 401  
- [ ] Idempotency key per mutation; new key after business-state change (e.g. new payable quote)  
- [ ] All amounts as `int` paise — never `double` rupees on the wire  
- [ ] IST dates for summary/report ranges  
- [ ] Hide register / enrol / KYC unless `agentCapabilities` says so  
- [ ] Collect modes: show CASH/UPI/CARD/BANK; label CASH as **Cash in hand**  
- [ ] QR: encode `qrPayload`, poll status, load payment on `paid`  
- [ ] Cash summary after every cash payment and handover  
- [ ] Block gold collect when rate missing  
- [ ] PDF receipt download via authenticated GET  

---

## 17. Minimal Dart sketch (QR poll)

```dart
Future<void> collectWithQr({
  required String schemeId,
  required int amountPaise,
  required int positionVersion,
  String? targetCycle,
}) async {
  final session = await api.post('/staff/payment-qr-sessions', body: {
    'schemeId': schemeId,
    'amountPaise': amountPaise,
    'expectedPositionVersion': positionVersion,
    if (targetCycle != null) 'targetCycle': targetCycle,
    'expiresInMinutes': 30,
  });

  final token = session['token'] as String;
  final qrPayload = session['qrPayload'] as String;
  showQr(qrPayload);

  while (mounted) {
    await Future<void>.delayed(const Duration(seconds: 3));
    final poll = await api.get('/staff/payment-qr-sessions/$token/status');
    if (poll['paid'] == true) {
      final paymentId = poll['receipt']?['paymentId'] ?? session['paymentId'];
      final payment = await api.get('/staff/payments/$paymentId');
      showReceipt(payment);
      return;
    }
    if (poll['failed'] == true) {
      throw StateError('Online payment failed');
    }
  }
}
```

---

*Source of truth: `src/routes/staff.routes.js`, `src/routes/auth.routes.js`, `src/validators/common.validators.js`, `src/constants/permissions.js`, payment QR session + agent attribution in `payment.service.js` / `payment-scope.js`.*
