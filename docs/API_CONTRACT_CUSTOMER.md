# Customer Web / App API Contract

**Audience:** Customer mobile app & customer web (`CUSTOMER`) + public pay/OTP surfaces

**Base:** `http://localhost:4000` · **Prefix:** `/api/v1` (except `/health*`)

> Money = integer **paise**. Weight = integer **mg**. Responses use **`id`** (not `_id`) on customer-facing DTOs where mapped.

## Scope

- Public: OTP, password login, tenant resolve, signup funnel, pay links, app config
- App auth: `/app/auth/*` (refresh, logout, me)
- Customer app: all `/app/*` routes below
- Health checks

**Route count (this panel):** **67** — full list in [Appendix C](#appendix-c--route-inventory-customer-panel)

**Examples:** Baseline request/response JSON per route in [Appendix F](#appendix-f--example-requests--responses) (numbers match Appendix C).

**Scheme × settings matrix:** Every route crossed with **FIXED / free-window / capped** flexible modes, **CASH vs GOLD_WEIGHT**, and **tenant operational flags** — [API_CONTRACT_CUSTOMER_MATRIX.md](./API_CONTRACT_CUSTOMER_MATRIX.md) and [Appendix G](#appendix-g--scheme--operations-response-matrix).

See also: [Full contract](./API_CONTRACT.md) · [Admin](./API_CONTRACT_ADMIN.md) · [Collection agent app](./API_CONTRACT_STAFF.md) · [Super Admin](./API_CONTRACT_SUPER_ADMIN.md)

## Locked product rules (V1)

- Flexible contributions are **optional**; flexible schemes are never due/overdue/defaulted for unpaid allowance.
- Unused monthly allowance **does not carry forward**; **paid money never expires** in the ledger.
- Schemes do not mature early; full payment only makes them non-payable until contractual maturity.
- Flexible online payments use **payment intents** in both free and capped phases.
- Payment initiation creates a **`PENDING` Payment** row, later `SUCCESS` or `FAILED`.
- Gold maturity valuation uses the latest rate **on or before** the maturity date.

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

**Headers:** `Authorization: Bearer <token>`, `X-Idempotency-Key: <uuid>` on mutating routes, `Content-Type: application/json`

**MoneyRef:** `{ "amountPaise": 100000, "amountDisplay": "₹1,000" }`  
**WeightRef:** `{ "weightMg": 1250, "weightDisplay": "1.250 g" }`

**Token TTL:** `expiresIn` is an **integer seconds** value (not `"30m"`).

**HTTP 426:** App below `minimumVersion` with `forceUpdate: true` in `/public/app-config` → `FORCE_UPDATE_REQUIRED`.

**Optimistic concurrency:** Scheme `expectedVersion`, flexible payments send **`expectedPositionVersion`** (must match latest payable-range **`positionVersion`**), grievances `expectedVersion`.

---

## Public

### `GET /api/v1/public/app-config`

```json
{
  "success": true,
  "data": {
    "android": { "minimumVersion": "1.0.0", "latestVersion": "1.0.0", "forceUpdate": false, "storeUrl": "https://play.google.com/..." },
    "ios": { "minimumVersion": "1.0.0", "latestVersion": "1.0.0", "forceUpdate": false, "storeUrl": "https://apps.apple.com/..." },
    "maintenance": { "enabled": false, "title": null, "message": null } 
  }
}
```

Client treats `forceUpdate: true` with app version below `minimumVersion` as **426 `FORCE_UPDATE_REQUIRED`**.

### `GET /health` · `GET /health/ready`

| Path | Auth | Response |
|------|------|----------|
| `/health` | none | `{ status: "ok", timestamp: ISO }` |
| `/health/ready` | none | `{ database: "ready", queue: "ready" }` |

### `GET /api/v1/public/tenants/:tenantId/branches`

Public branch picker (signup/branding). Returns array of `{ id, code, name, mobile?, address? }`.

### `GET /api/v1/public/tenants/resolve`

**Query (one of):** `tenantCode`, `mobile`, `deepLinkToken`

**Response (200):**

```json
{
  "success": true,
  "data": {
    "resolvedBy": "MOBILE|TENANT_CODE|DEEP_LINK",
    "tenantCode": "ABC",
    "tenants": [
      {
        "id": "tnt_...",
        "tenantCode": "ABC",
        "displayName": "Malabar Jewellers",
        "appDisplayName": "Malabar Savings",
        "logoUrl": "/uploads/upl_...",
        "primaryColor": "#730321",
        "accentColor": "#C9A227",
        "foregroundColor": "#FFFFFF",
        "contrastColor": "#730321",
        "supportNumber": "+91...",
        "city": "Kochi",
        "status": "ACTIVE",
        "resolvedBy": "MOBILE"
      }
    ]
  }
}
```

One mobile may return **multiple tenants** when the customer exists at more than one jeweller.

### `POST /api/v1/public/auth/otp/request`

**Body:** `{ "tenantCode", "mobile", "purpose": "LOGIN|SIGNUP|PASSWORD_RESET", "deviceId" }`

**Response (202):**

```json
{
  "success": true,
  "data": {
    "otpId": "uuid",
    "channel": "SMS",
    "maskedMobile": "******3456",
    "resendAvailableInSeconds": 30,
    "attemptsAllowed": 5,
    "isRegistered": true,
    "expiresInSeconds": 300
  }
}
```

### `POST /api/v1/public/auth/otp/verify`

**Body:** `{ "tenantCode", "mobile", "purpose", "deviceId", "otp", "otpId", "deviceInfo?" }` — **`otpId` is required** (from the matching OTP request response).

**Response (200):**

```json
{
  "success": true,
  "data": {
    "isNewCustomer": false,
    "profileComplete": true,
    "customer": {
      "id": "cus_...",
      "name": "Anjali",
      "mobile": "+91...",
      "branchId": "brn_...",
      "passbookNumber": "BR/2026/00012",
      "branch": { "id": "brn_...", "name": "Main", "code": "MAIN" },
      "profileComplete": true
    },
    "tenant": {
      "tenantCode": "ABC",
      "displayName": "Malabar Jewellers",
      "appDisplayName": "Malabar Savings",
      "logoUrl": "/uploads/upl_...",
      "primaryColor": "#730321",
      "accentColor": "#C9A227",
      "foregroundColor": "#FFFFFF",
      "contrastColor": "#730321",
      "supportNumber": "+91...",
      "city": "Kochi"
    },
    "tenantCapabilities": {
      "customerSelfEnrol": true,
      "customerSelfRegistration": true,
      "kycMandatory": false,
      "multiScheme": true
    },
    "accessToken": "jwt",
    "refreshToken": "opaque",
    "expiresIn": 1800,
    "tokenType": "Bearer"
  }
}
```

Incomplete profile after signup → `profileComplete: false`; finish with `POST /app/profile/complete`.

### `GET /api/v1/public/pay/:linkToken`

Public payment page DTO (no auth): jeweller branding, masked customer, amount, `canPay`, expiry message.

### `GET /api/v1/public/pay/:linkToken/status`

Poll payment result (no auth):

```json
{
  "success": true,
  "data": {
    "status": "PROCESSING|PAID|FAILED|EXPIRED|CANCELLED",
    "processing": true,
    "paid": false,
    "failed": false,
    "receipt": null,
    "updatedScheme": null,
    "retryAfterSeconds": 3
  }
}
```

### `POST /api/v1/public/pay/:linkToken/initiate`

**Response:** `{ "gatewayUrl", "transactionId", "paymentId", "expiresAt" }` — creates/continues a **`PENDING`** payment.

---

## App auth (`/api/v1/app/auth`)

| Method | Path | Notes |
|--------|------|--------|
| POST | `/refresh` | Body `{ refreshToken }` → tokens + integer `expiresIn` |
| POST | `/logout` | Bearer + optional refresh token |
| GET | `/me` | Same safe profile DTO as `GET /app/profile` (`id`, never `_id`) |

---

## Customer app (`/api/v1/app/*`)

All routes require **Bearer CUSTOMER** unless noted.

### Devices & sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/devices` | List active sessions (`deviceId`, `platform`, `lastUsedAt`, …) |
| DELETE | `/auth/devices/:deviceId` | Revoke refresh-token family for that device |
| POST | `/devices/fcm-token` | Body: `fcmToken`, `deviceId`, `platform`, `appVersion?`, `osVersion?`, `deviceModel?`. Response includes `replacedPreviousToken: true` when a prior token for that `deviceId` was replaced. |
| DELETE | `/devices/fcm-token` | Body: `{ "deviceId" }` — removes FCM row and revokes device sessions (shared-device safe) |

### Profile & uploads

| Method | Path | Description |
|--------|------|-------------|
| GET | `/profile` | Structured profile + KYC + branch + tenant branding |
| PATCH | `/profile` | Update allowed fields (mobile **immutable** → `MOBILE_CHANGE_NOT_SUPPORTED`) |
| POST | `/profile/complete` | Complete registration after OTP (`name` required) |
| PUT | `/profile/kyc` | Submit KYC; verified KYC cannot be silently replaced (`KYC_ALREADY_VERIFIED`) |
| POST | `/uploads/presign` | Body: `{ purpose: KYC_DOCUMENT\|GRIEVANCE_ATTACHMENT, fileName, contentType, sizeBytes }` → `{ uploadId, uploadUrl, method, headers, expiresAt }` |

### Home

**GET `/home`**

Query: `includeTrends=true`, `trendMonths=6`

**Response `data` (nested DTO — see also Appendix E):**

- `tenant` — `TenantBranding`
- `customer` — `{ id, name, profileComplete }`
- `greeting` — `{ text, subtext }`
- `hasGoldAccumulationScheme` — `true` if the customer has any scheme with `valueBasis` `GOLD_WEIGHT`
- `summary` — `{ activeSchemeCount, pastSchemeCount, totalPaid, goldAccumulated?, currentValuation? }` (gold fields omitted when `hasGoldAccumulationScheme` is false)
- `goldRate` — same shape as below, or `null` when the customer has no gold-weight scheme
- `actionCard` — `null` or `{ type, schemeId, title, priority }` where **`type`** is `PAY_DUE` \| `REDEEM`
- `activeSchemes[]` — scheme card summaries (`displayMode`, `installmentAmount`, `maturityDate`, …)
- `pastSchemesPreview[]`, `quickActions[]` (`key`: `PAY` \| `ENROL` \| `PASSBOOK`)
- `unreadNotificationCount`, optional `contributionTrend` / `goldAccumulationTrend`, `emptyState`, `cacheTtlSeconds`

### Scheme plans (customer-safe)

**GET `/scheme-plans`**, **GET `/scheme-plans/:planId`**

Curated plan cards (see `mapCustomerPlanListItem` in `customer-app-dto.js`): `displayName`, `description`, `valueBasis`, `valueBasisLabel`, `paymentPattern`, `paymentPatternLabel`, `durationMonths`, `amountSummary` (`{ label, min, max, multipleOf, amountMode }`), `benefitLabel`, `benefitType`, `highlights[]`, optional `flexibleSummary`, `canEnrol`, `blockedReason` — **no** raw `amountRules` / `flexibleRules` blobs.

**Calendar tenure vs contribution cycles (V1):** `durationMonths` is the number of consecutive calendar months from enrolment to maturity (last day of the final month). When `installmentCount` is set, it is the number of **contribution** cycles (fixed instalments, or flexible free+capped phases combined). Example: flexible `durationMonths: 12` with `installmentCount: 11` and `6+5` phases yields 12 calendar cycles on the scheme; month 12 is maturity-only — `GET payable-range` / payments in that month return **`422 MATURITY_WAITING_CYCLE`**. Fixed plans may use `durationMonths: 12` with `installmentCount: 11` (11 payable instalments; maturity still at end of month 12).

### Schemes

Examples: [F.39](#f39-get-apiv1appschemes)–[F.47](#f47-post-apiv1appschemesschemeidpaysdk-order) (read/pay), [F.67](#f67-post-apiv1appschemesschemeidredemption-request) (redeem).

| Method | Path | Notes |
|--------|------|--------|
| GET | `/schemes` | Query `group=PAST` for closed schemes with closure DTO |
| GET | `/schemes/:schemeId` | **`CustomerSchemeDetail`** (see Appendix A) — mapped in `customer-scheme-detail-dto.js`, not raw Mongo |
| GET | `/schemes/:schemeId/payable-range` | Query `targetCycle` (capped phase); enriched quote (see below) |
| GET | `/schemes/:schemeId/passbook` | Passbook rows |
| GET | `/schemes/:schemeId/settlement-preview` | Maturity preview; query `mode` required for gold-weight schemes (`CASH`, `GOLD_HANDOVER`, or `PURCHASE_ADJUSTMENT`) |
| POST | `/schemes/enrol` | Body: `{ planId, installmentAmountPaise?, payNow?, redirectUrl? }` only — plan decides first-instalment timing (customer cannot send `firstInstallmentMode`). Response discriminates `paymentType`: `FIXED_PAYMENT_LINK` \| `FLEXIBLE_PAYMENT_INTENT`. |
| POST | `/schemes/:schemeId/pay` | **Fixed schemes only** → payment link DTO. Flexible → `422 FLEXIBLE_PAYMENT_INTENT_REQUIRED`. |
| POST | `/schemes/:schemeId/payment-intents` | **Flexible only**; body `{ amountPaise, targetCycle?, expectedPositionVersion, redirectUrl? }` |
| POST | `/schemes/:schemeId/redemption-request` | Body: `{ preferredMode, preferredDate?, remarks?, expectedVersion }` → non-financial `REQUESTED` redemption |

**Payable range — fixed schemes (via `enrichPayableRange`):** includes `currentInstallmentNumber`, `reservedPaise`, `minPayable` / `maxPayable`, `allowedAmountsPaise` (when partial disabled), `advancePaymentAllowed`, `maxAdvanceInstallments` (**future** slots **in addition to** current), `partialPaymentAllowed`, `expectedPositionVersion`. Online reservations block conflicting manual staff payments until the link is cancelled (`PAYMENT_CONFIRMATION_PENDING`). Stale successful gateway payments may land in `UNALLOCATED_PENDING_REVIEW`.

**Payable range (flexible example fields):**

```json
{
  "model": "FLEXIBLE",
  "phase": "CAPPED",
  "contributionIsOptional": true,
  "targetCycle": "2026-03",
  "minPayable": { "amountPaise": 50000, "amountDisplay": "₹500" },
  "maxPayable": { "amountPaise": 150000, "amountDisplay": "₹1,500" },
  "cycleCap": { "amountPaise": 200000, "amountDisplay": "₹2,000" },
  "paidThisCycle": { "amountPaise": 50000, "amountDisplay": "₹500" },
  "remainingThisCycle": { "amountPaise": 150000, "amountDisplay": "₹1,500" },
  "suggested": { "amountPaise": 150000, "amountDisplay": "₹1,500" },
  "multipleOfPaise": 100,
  "multipleOf": { "amountPaise": 100, "amountDisplay": "₹1" },
  "maxReason": null,
  "nextCycleAction": "PAY_CURRENT_CYCLE",
  "finalRemainderException": false,
  "isMandatory": false,
  "quickAmounts": [],
  "helperText": "Contributions are optional...",
  "positionVersion": 12,
  "unusedAllowanceCarriesForward": false,
  "paidMoneyNeverExpires": true
}
```

**Past scheme row (`group=PAST`):** `closureType`, `closedAt`, `finalValue`, `benefitReceived`, `redemptionMode`, `billNumber`, `closureReceiptUrl`, `passbookAvailable`.

**Enrol response (201) when `payNow` and first instalment due:**

```json
{
  "success": true,
  "data": {
    "scheme": { "id": "sch_...", "schemeNumber": "ENR-..." },
    "paymentType": "FIXED_PAYMENT_LINK",
    "paymentLink": {
      "id": "plk_...",
      "gatewayUrl": "/pay/<token>",
      "amount": { "amountPaise": 250000, "amountDisplay": "₹2,500" },
      "expiresAt": "ISO"
    }
  }
}
```

Flexible plans return `"paymentType": "FLEXIBLE_PAYMENT_INTENT"` and `"paymentIntent": { ... }` instead.

### Payments

| Method | Path | Notes |
|--------|------|--------|
| GET | `/payments` | Cursor list — customer DTO rows via `mapCustomerPaymentListItem`; `meta.summary` has `totalPaidPaise`, `successCount`, `activeSchemeCount` |
| GET | `/payments/:paymentId` | Single passbook row (same shape as list item) |
| GET | `/payments/:linkId/status` | `{ processing, paid, failed, receipt, updatedScheme }` — not an empty array |
| GET | `/payments/:paymentId/receipt` | **PDF stream** — `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="<receiptNumber>.pdf"` |
| GET | `/payment-intents/:intentId` | Intent + `statusPollUrl`, `paymentUrl`, `expiresAt` |
| POST | `/payment-intents/:intentId/cancel` | Body `{ expectedPositionVersion }` required |

Fixed scheme calling payment intents → `PAYMENT_INTENT_NOT_APPLICABLE`.

### Notifications

**GET `/notifications`** → `{ items: [{ id, type, title, body, createdAt, read, deepLink, cta, imageUrl }], unreadCount }`

**POST `/notifications/:id/read`**, **POST `/notifications/read-all`**

### Grievances

| Method | Path | Notes |
|--------|------|--------|
| POST | `/grievances` | Create with optional `attachmentUploadIds` |
| GET | `/grievances` | Filters: `status`, `category`, cursor |
| GET | `/grievances/:grievanceId` | Detail + messages + SLA fields |
| POST | `/grievances/:grievanceId/messages` | Body `{ body, attachmentUploadIds?, expectedVersion }` (**required**) — server always stores **PUBLIC_REPLY** |
| POST | `/grievances/:grievanceId/reopen` | Body `{ reason, expectedVersion }`, 7-day window, `VERSION_CONFLICT` |

Customers cannot send `INTERNAL_NOTE` or `SYSTEM_EVENT`.

### Branches & gold rate

**GET `/branches`**, **GET `/gold-rate/current`**, **GET `/gold-rate/history`**

---

## Error codes (customer-relevant)

| Code | When |
|------|------|
| `UNAUTHENTICATED` | Missing/invalid token |
| `OTP_INVALID` / `OTP_RESEND_COOLDOWN` | OTP verify/send |
| `CUSTOMER_NOT_REGISTERED` | LOGIN OTP when mobile unknown |
| `FLEXIBLE_PAYMENT_INTENT_REQUIRED` | Fixed vs flexible payment route mismatch |
| `PAYMENT_INTENT_NOT_APPLICABLE` | Intent on fixed scheme |
| `PAYMENT_POSITION_CHANGED` | Stale `expectedPositionVersion` |
| `VERSION_CONFLICT` | Grievance/scheme version mismatch |
| `KYC_ALREADY_VERIFIED` | Replacing verified KYC |
| `MOBILE_CHANGE_NOT_SUPPORTED` | Profile mobile change |
| `FORCE_UPDATE_REQUIRED` | App version (426) |

---

## P1.5 (not required for V1)

- `POST /app/auth/logout-all` — revoke all customer sessions (may be added later).

---

## Appendix A — `CustomerSchemeDetail` (`GET /app/schemes/:schemeId`)

Common top-level fields: `id`, `schemeNumber`, `planName`, `displayMode` (`FIXED` \| `FLEXIBLE_FREE_WINDOW` \| `FLEXIBLE_LOCK_WINDOW`), `status`, `uiStatus`, `statusLabel`, `header`, `progressCard`, `statCards[]`, `payButton`, `passbookSummary`, `redemption`, `lifecycleActions`, `version`, `positionVersion`, `helperText`.

| `displayMode` | `progressCard.type` | Extra UI |
|---------------|---------------------|----------|
| `FIXED` | `FIXED` | `installmentsPaid/Total`, `nextDue`, passbook instalment rows |
| `FLEXIBLE_FREE_WINDOW` | `FLEXIBLE_FREE_WINDOW` | `freeWindowBanner`, min/max per payment, optional contributions |
| `FLEXIBLE_LOCK_WINDOW` | `FLEXIBLE_LOCK_WINDOW` | `cycleCap`, **`paidThisCycle`**, `remainingThisCycle`, `currentCycle`, locked average |

Contract tests: `tests/customer-app-contract.test.js` (all three display modes).

## Appendix B — Pending payment lifecycle (intents & public pay)

1. **Intent create** (`POST .../payment-intents`): creates **`PaymentIntent` (PENDING)** + **`Payment` (PENDING)** with shared amount; **`paymentId` is always set** on the intent before gateway call.
2. **Gateway success webhook**: `Payment` → `SUCCESS`, intent → `SUCCEEDED`, scheme ledger allocated; idempotent on provider event id.
3. **Gateway failure / initiation error**: intent → `FAILED`, payment → `FAILED`, **`positionVersion` incremented** (reservation released).
4. **Customer cancel** (`POST .../cancel` + `expectedPositionVersion`): intent → `CANCELLED`, payment → `FAILED` (`cancellationReason: CUSTOMER_CANCELLED`), reservation released, `positionVersion` bumped.
5. **Intent expiry** (reservation TTL): intent → `EXPIRED`, linked payment → `FAILED` if still `PENDING`.
6. **Public link initiate**: creates/reuses **`PENDING` Payment**; poll maps `PROCESSING` while pending, `PAID` on success, `EXPIRED`/`CANCELLED`/`FAILED` for terminals.
7. **Late success callback**: allowed only while payment still `PENDING`/`FAILED` per worker rules; duplicate callbacks are no-ops (idempotent).

Poll UI enum: **`PROCESSING` \| `PAID` \| `FAILED` \| `EXPIRED` \| `CANCELLED`**.

## Appendix C — Route inventory (customer panel)

**Total: 67** (2 health + 19 public + 3 app auth + 43 app). Handlers: `src/routes/public.routes.js`, `src/routes/app-auth.routes.js`, `src/routes/app.routes.js`.

| # | Method | Path |
|---|--------|------|
| 1 | GET | `/health` |
| 2 | GET | `/health/ready` |
| 3 | GET | `/api/v1/public/app-config` |
| 4 | GET | `/api/v1/public/auth/password-policy` |
| 5 | POST | `/api/v1/public/auth/otp/request` |
| 6 | POST | `/api/v1/public/auth/otp/verify` |
| 7 | POST | `/api/v1/public/auth/login-password` |
| 8 | POST | `/api/v1/public/auth/set-password` |
| 9 | GET | `/api/v1/public/tenants/resolve` |
| 10 | GET | `/api/v1/public/tenants/:tenantId/branches` |
| 11 | POST | `/api/v1/public/signup/start` |
| 12 | POST | `/api/v1/public/signup/verify-otp` |
| 13 | GET | `/api/v1/public/signup/plans` |
| 14 | POST | `/api/v1/public/signup/:signupId/select-plan` |
| 15 | POST | `/api/v1/public/signup/:signupId/payment/initiate` |
| 16 | GET | `/api/v1/public/signup/:signupId/status` |
| 17 | GET | `/api/v1/public/signup/check-availability` |
| 18 | GET | `/api/v1/public/pay/:linkToken` |
| 19 | POST | `/api/v1/public/pay/:linkToken/initiate` |
| 20 | GET | `/api/v1/public/pay/:linkToken/status` |
| 21 | GET | `/api/v1/public/uploads/:uploadId` |
| 22 | POST | `/api/v1/app/auth/refresh` |
| 23 | POST | `/api/v1/app/auth/logout` |
| 24 | GET | `/api/v1/app/auth/me` |
| 25 | GET | `/api/v1/app/auth/devices` |
| 26 | DELETE | `/api/v1/app/auth/devices/:deviceId` |
| 27 | GET | `/api/v1/app/home` |
| 28 | GET | `/api/v1/app/profile` |
| 29 | PATCH | `/api/v1/app/profile` |
| 30 | POST | `/api/v1/app/profile/complete` |
| 31 | PUT | `/api/v1/app/profile/kyc` |
| 32 | PUT | `/api/v1/app/profile/nominee` |
| 33 | DELETE | `/api/v1/app/profile/nominee` |
| 34 | POST | `/api/v1/app/uploads/presign` |
| 35 | POST | `/api/v1/app/uploads/:uploadId/complete` |
| 36 | GET | `/api/v1/app/uploads/:uploadId` |
| 37 | GET | `/api/v1/app/scheme-plans` |
| 38 | GET | `/api/v1/app/scheme-plans/:planId` |
| 39 | GET | `/api/v1/app/schemes` |
| 40 | GET | `/api/v1/app/schemes/:schemeId/payable-range` |
| 41 | GET | `/api/v1/app/schemes/:schemeId/passbook` |
| 42 | GET | `/api/v1/app/schemes/:schemeId/settlement-preview` |
| 43 | GET | `/api/v1/app/schemes/:schemeId` |
| 44 | POST | `/api/v1/app/schemes/enrol` |
| 45 | POST | `/api/v1/app/schemes/:schemeId/pay` |
| 46 | POST | `/api/v1/app/schemes/:schemeId/payment-intents` |
| 47 | POST | `/api/v1/app/schemes/:schemeId/pay/sdk-order` |
| 48 | GET | `/api/v1/app/payment-intents/:intentId` |
| 49 | POST | `/api/v1/app/payment-intents/:intentId/cancel` |
| 50 | GET | `/api/v1/app/payments` |
| 51 | GET | `/api/v1/app/payments/:paymentId/receipt` |
| 52 | GET | `/api/v1/app/payments/:paymentId` |
| 53 | GET | `/api/v1/app/payments/:linkId/status` |
| 54 | GET | `/api/v1/app/notifications` |
| 55 | POST | `/api/v1/app/notifications/:id/read` |
| 56 | POST | `/api/v1/app/notifications/read-all` |
| 57 | POST | `/api/v1/app/devices/fcm-token` |
| 58 | DELETE | `/api/v1/app/devices/fcm-token` |
| 59 | GET | `/api/v1/app/branches` |
| 60 | GET | `/api/v1/app/gold-rate/current` |
| 61 | GET | `/api/v1/app/gold-rate/history` |
| 62 | POST | `/api/v1/app/grievances` |
| 63 | GET | `/api/v1/app/grievances` |
| 64 | GET | `/api/v1/app/grievances/:grievanceId` |
| 65 | POST | `/api/v1/app/grievances/:grievanceId/messages` |
| 66 | POST | `/api/v1/app/grievances/:grievanceId/reopen` |
| 67 | POST | `/api/v1/app/schemes/:schemeId/redemption-request` |

## Appendix D — Upload presign

| Purpose | MIME | Max size |
|---------|------|----------|
| `KYC_DOCUMENT` | jpeg, png, pdf | 5 MB |
| `GRIEVANCE_ATTACHMENT` | jpeg, png, pdf | 5 MB |

Presign TTL: **15 minutes**. Response: `{ uploadId, uploadUrl, method: "PUT", headers, expiresAt }`.

## Appendix E — Frontend DTO reference

Shared types: **`TenantBranding`** (`tenantCode`, `displayName`, `appDisplayName`, `logoUrl`, `primaryColor`, `accentColor`, `foregroundColor`, `contrastColor`, `supportNumber`, `city`); **`MoneyRef`** / **`WeightRef`** as in Conventions.

| Surface | Key fields |
|---------|------------|
| **Profile** (`GET /app/profile`, `/app/auth/me`) | `id`, `customerNumber`, `passbookNumber`, `name`, `mobile`, `mobileImmutable: true`, `email`, `dateOfBirth`, `address`, `branch`, `whatsappOptIn`, `memberSince`, `profileComplete`, `profileCompleteness: { filled, total, complete }`, `kyc: { status, statusLabel, type, numberMasked, canUpdate, verifiedAt }`, `nominee`, `status`, `version`, `tenant` |
| **Payment list item** | `id`, `amount` (MoneyRef), `status`, `statusLabel`, `paidAt`, `createdAt`, `schemeId`, `schemeNumber`, `schemeName`, `receiptNumber` (success only; no `PENDING-*`), `receiptDownloadPath` (`/app/payments/:id/receipt` when success), `channel`, `channelLabel`, `paymentPattern`, optional `targetCycle` |
| **Payment intent** | `id`, `schemeId`, `targetCycle`, `amount`, `status` (`PENDING` \| `SUCCEEDED` \| `FAILED` \| `CANCELLED` \| `EXPIRED`), `positionVersion`, `paymentId`, `expiresAt`, `paymentUrl`, `statusPollUrl`, `retryAfterSeconds` |
| **Intent cancel (200)** | `intentId`, `intentStatus`, `paymentId`, `paymentStatus`, `positionVersion`, `reservationReleased` |
| **Notification** | `type` (`GENERAL`, `PAYMENT`, `SCHEME`, `GRIEVANCE`, … — server template key), `title`, `body`, `read`, `deepLink` (app-relative paths only, e.g. `/schemes/:id`, `/payments/:id`, `/grievances/:id`), `cta`, `imageUrl` |
| **Grievance list row** | `id`, `ticketNumber`, `category`, `status`, `statusLabel`, `subject`, `createdAt`, `updatedAt`, `slaDueAt`, `unreadForCustomer` |
| **Grievance detail** | list fields + `description`, `version`, `messages[]: { id, authorType, body, createdAt, attachments[] }`, `allowedActions[]` |
| **Branch** | `id`, `code`, `name`, `mobile?`, `address?` (public + app routes map `_id` → `id`) |
| **Gold rate current** | `ratePerGramPaise`, `ratePerGramDisplay`, `effectiveDate`, `purity`, `movement?` |
| **Gold rate history row** | `effectiveDate`, `ratePerGramPaise`, `ratePerGramDisplay`, `purity` |
| **Settlement / redemption preview** | `eligible`, `blockers[]: { code, message }`, `maturityDate`, `goldRateDateApplied`, `benefits`, `totals` (MoneyRef / WeightRef), `redemptionStatus` |
| **Redemption request (201)** | `id`, `schemeId`, `status: REQUESTED`, `preferredMode`, `preferredDate`, `version` |

## Appendix G — Scheme & operations response matrix

Full document: **[API_CONTRACT_CUSTOMER_MATRIX.md](./API_CONTRACT_CUSTOMER_MATRIX.md)** (maintained alongside this file).

| Topic | Matrix section |
|-------|----------------|
| Display modes & value basis | §1 |
| `customerSelfEnrol`, `customerSelfRegistration`, `kycMandatory`, `multiScheme`, login mode, view-only, payments off | §2–§2.1, §6 |
| All 67 routes → shape + which variants apply | §3, §7 |
| Home / list / detail / payable-range / settlement / enrol / payments by scheme type | §5.1–§5.8 |
| Public pay link FIXED vs FLEXIBLE label | §4.1 |
| FIXED partial/advance payable-range | §5.4 |
| Capped `CYCLE_CAP_REACHED`, future-cycle options | §5.4 |
| Settlement `modePreviews` (GOLD_WEIGHT) | §5.5 |
| `payButton` when payments disabled / matured | §5.6 |

Use **Appendix F** for copy-paste baselines; use the **matrix** when implementing UI for every plan type and jeweller setting.

## Appendix F — Example requests & responses

Route numbers match [Appendix C](#appendix-c--route-inventory-customer-panel). Payload shapes follow `customer-app-dto.js`, `customer-scheme-detail-dto.js`, and validators in `common.validators.js`. Wrapper: `{ "success": true, "data": … }` unless noted.

For **FIXED vs FLEXIBLE_FREE_WINDOW vs FLEXIBLE_LOCK_WINDOW**, **GOLD_WEIGHT**, and **tenant capability** variants, see [Appendix G](#appendix-g--scheme--operations-response-matrix) / [MATRIX](./API_CONTRACT_CUSTOMER_MATRIX.md).

### F.1 `GET /health`

**Response (200):** `{ "status": "ok", "timestamp": "2026-09-22T06:00:00.000Z" }`

### F.2 `GET /health/ready`

**Response (200):** `{ "database": "ready", "queue": "ready" }`

### F.3 `GET /api/v1/public/app-config`

**Response (200):**

```json
{
  "success": true,
  "data": {
    "android": { "minimumVersion": "1.0.0", "latestVersion": "1.2.0", "forceUpdate": false, "storeUrl": "https://play.google.com/..." },
    "ios": { "minimumVersion": "1.0.0", "latestVersion": "1.2.0", "forceUpdate": false, "storeUrl": "https://apps.apple.com/..." },
    "maintenance": { "enabled": false, "title": null, "message": null }
  }
}
```

### F.4 `GET /api/v1/public/auth/password-policy`

**Response (200):**

```json
{
  "success": true,
  "data": {
    "minLength": 4,
    "maxLength": 128,
    "numericOnly": true,
    "requireUppercase": false,
    "requireLowercase": false,
    "requireNumber": true,
    "requireSymbol": false
  }
}
```

### F.5 `POST /api/v1/public/auth/otp/request`

**Request:**

```json
{
  "tenantCode": "NAKSHATHRAJE",
  "mobile": "+919999999902",
  "purpose": "LOGIN",
  "deviceId": "web-chrome-abc123"
}
```

**Response (202):**

```json
{
  "success": true,
  "data": {
    "otpId": "550e8400-e29b-41d4-a716-446655440000",
    "channel": "SMS",
    "maskedMobile": "******9902",
    "resendAvailableInSeconds": 30,
    "attemptsAllowed": 5,
    "isRegistered": true,
    "expiresInSeconds": 300
  }
}
```

### F.6 `POST /api/v1/public/auth/otp/verify`

**Request:**

```json
{
  "tenantCode": "NAKSHATHRAJE",
  "mobile": "+919999999902",
  "purpose": "LOGIN",
  "deviceId": "web-chrome-abc123",
  "otp": "123456",
  "otpId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response (200):**

```json
{
  "success": true,
  "data": {
    "isNewCustomer": false,
    "profileComplete": true,
    "customer": {
      "id": "cus_01M33R10B7RPVJZEZMRVR5VBPW",
      "name": "Sarath Kumar",
      "mobile": "+919999999902",
      "branchId": "brn_01M33EXAMPLE",
      "passbookNumber": "PB/2026/00012",
      "branch": { "id": "brn_01M33EXAMPLE", "name": "Main Showroom", "code": "MAIN" },
      "profileComplete": true
    },
    "tenant": {
      "tenantCode": "NAKSHATHRAJE",
      "displayName": "Nakshathra Jewellers",
      "appDisplayName": "Nakshathra Savings",
      "logoUrl": "/uploads/upl_01M33EXAMPLE",
      "primaryColor": "#730321",
      "accentColor": "#C9A227",
      "customerLoginMode": "OTP_ONLY",
      "customerAppPaymentsEnabled": true
    },
    "tenantCapabilities": {
      "customerSelfEnrol": true,
      "customerSelfRegistration": true,
      "kycMandatory": false,
      "multiScheme": true,
      "customerLoginMode": "OTP_ONLY",
      "customerAppWriteEnabled": true,
      "customerAppPaymentsEnabled": true
    },
    "accessToken": "eyJ...",
    "refreshToken": "rt_...",
    "expiresIn": 1800,
    "tokenType": "Bearer"
  }
}
```

### F.7 `POST /api/v1/public/auth/login-password`

**Request:** `{ "tenantCode": "NAKSHATHRAJE", "mobile": "+919999999902", "password": "1234", "deviceId": "android-pixel-8" }`

**Response (200):** Same session shape as [F.6](#f6-post-apiv1publicauthotpverify).

### F.8 `POST /api/v1/public/auth/set-password`

**Request:** `{ "resetToken": "<32+ chars>", "password": "5678", "confirmPassword": "5678" }`

**Response (200):** `{ "success": true, "data": { "passwordSet": true } }`

### F.9 `GET /api/v1/public/tenants/resolve?tenantCode=NAKSHATHRAJE`

**Response (200):**

```json
{
  "success": true,
  "data": {
    "resolvedBy": "TENANT_CODE",
    "tenantCode": "NAKSHATHRAJE",
    "tenants": [
      {
        "id": "tnt_01M33NZ7JMR9ABR5MCP306YQN7",
        "tenantCode": "NAKSHATHRAJE",
        "displayName": "Nakshathra Jewellers",
        "status": "ACTIVE",
        "customerAppPaymentsEnabled": true
      }
    ]
  }
}
```

### F.10 `GET /api/v1/public/tenants/:tenantId/branches`

**Response (200):** `{ "success": true, "data": [{ "id": "brn_01M33EXAMPLE", "code": "MAIN", "name": "Main Showroom" }] }`

### F.11–F.17 Public signup (tenant onboarding)

| # | Request | Response |
|---|---------|----------|
| F.11 | `POST /signup/start` `{ businessName, ownerName, mobile, email, city }` | `201` signup session |
| F.12 | `POST /signup/verify-otp` `{ signupId, otp }` | Signup token |
| F.13 | `GET /signup/plans` | Subscription plans |
| F.14 | `POST /:signupId/select-plan` `{ subscriptionPlanId, billingCycle }` | Selected plan |
| F.15 | `POST /:signupId/payment/initiate` `{ redirectUrl }` | Checkout |
| F.16 | `GET /:signupId/status` | Status DTO |
| F.17 | `GET /signup/check-availability` | `{ available: true }` |

### F.18 `GET /api/v1/public/pay/:linkToken`

**Response (200):** `publicPayPageDto` — `{ linkId, status, jeweller, customerName, maskedMobile, schemeLabel, amount (MoneyRef), canPay, expiresAt }`

### F.19 `POST /api/v1/public/pay/:linkToken/initiate`

**Request:** `{ "redirectUrl": "https://customer.example.com/pay/status", "mobile": "+919999999902" }`

**Response (200):** `{ "gatewayUrl", "transactionId", "paymentId", "expiresAt" }`

### F.20 `GET /api/v1/public/pay/:linkToken/status`

**Response (200):** Pay page + `poll`: `{ status, processing, paid, failed, receipt, updatedScheme, retryAfterSeconds }`

### F.21 `GET /api/v1/public/uploads/:uploadId`

**Response:** Binary file (not JSON).

### F.22 `POST /api/v1/app/auth/refresh`

**Request:** `{ "refreshToken": "rt_..." }`

**Response (200):** `{ "accessToken", "refreshToken", "expiresIn": 1800, "tokenType": "Bearer" }`

### F.23 `POST /api/v1/app/auth/logout`

**Request:** optional `{ "refreshToken" }` · **Headers:** `Authorization: Bearer …`

**Response (200):** `{ "success": true, "data": { "loggedOut": true } }`

### F.24 `GET /api/v1/app/auth/me`

**Response (200):** Same as [F.28](#f28-get-apiv1appprofile).

### F.25 `GET /api/v1/app/auth/devices`

**Response (200):** `{ "success": true, "data": [{ "deviceId", "platform", "lastUsedAt", "expiresAt" }] }`

### F.26 `DELETE /api/v1/app/auth/devices/:deviceId`

**Response (200):** `{ "success": true, "data": { "revoked": true } }`

### F.27 `GET /api/v1/app/home?includeTrends=true&trendMonths=6`

**Response (200):** `buildHome` shell — tenant branding, greeting, summary, optional trends, `activeSchemes[]`.

**Scheme cards:** three `displayMode` shapes in [MATRIX §5.1](./API_CONTRACT_CUSTOMER_MATRIX.md#51-get-apphome--activeschemes-maphomeschemecard).

### F.28 `GET /api/v1/app/profile`

**Response (200):** `customerProfileDto` — `{ id, customerNumber, passbookNumber, name, mobile, mobileImmutable: true, email, address, branch, profileComplete, nominee, version, tenant }`

### F.29 `PATCH /api/v1/app/profile`

**Request:** `{ "email", "address", "expectedVersion" }`

**Response (200):** Updated profile DTO.

### F.30 `POST /api/v1/app/profile/complete`

**Request:** `{ "name": "Sarath Kumar", "email": "sarath@example.com" }`

**Response (200):** Profile with `profileComplete: true`.

### F.31 `PUT /api/v1/app/profile/kyc`

**Request:** `{ "type": "AADHAAR", "frontUploadId", "backUploadId" }`

**Response (200):** Profile with `kyc.status: "SUBMITTED"` (403 when KYC not enabled).

### F.32 `PUT /api/v1/app/profile/nominee`

**Request:** `{ "name", "relationship": "SPOUSE", "mobile", "expectedVersion" }`

### F.33 `DELETE /api/v1/app/profile/nominee`

**Request:** `{ "expectedVersion": 5 }`

### F.34 `POST /api/v1/app/uploads/presign`

**Request:** `{ "purpose": "KYC_DOCUMENT", "fileName", "contentType", "sizeBytes" }`

**Response (200):** `{ uploadId, uploadUrl, method: "PUT", headers, expiresAt }`

### F.35 `POST /api/v1/app/uploads/:uploadId/complete`

**Response (200):** `{ uploadId, status: "READY" }`

### F.36 `GET /api/v1/app/uploads/:uploadId`

**Response:** Binary download.

### F.37–F.38 `GET /api/v1/app/scheme-plans` · `GET .../:planId`

**Response (200):** `mapCustomerPlanListItem` — FIXED vs FLEXIBLE examples in [MATRIX §5.2](./API_CONTRACT_CUSTOMER_MATRIX.md#52-get-appscheme-plans--plan-list-item); `canEnrol: false` when self-enrol disabled.

### F.39 `GET /api/v1/app/schemes`

**Active:** `{ data: [ SchemeCard ], meta }` — same card shapes as home [§5.1](./API_CONTRACT_CUSTOMER_MATRIX.md#51-get-apphome--activeschemes-maphomeschemecard). **Past:** `?group=PAST` → [§5.3](./API_CONTRACT_CUSTOMER_MATRIX.md#53-get-appschemesgrouppast--mappastschemerow).

### F.40 `GET /api/v1/app/schemes/:schemeId/payable-range?targetCycle=2026-09`

**Response (200):**

```json
{
  "success": true,
  "data": {
    "model": "FLEXIBLE",
    "phase": "CAPPED",
    "payable": true,
    "targetCycle": "2026-09",
    "minPayable": { "amountPaise": 10000, "amountDisplay": "₹100" },
    "maxPayable": { "amountPaise": 40000, "amountDisplay": "₹400" },
    "cycleCap": { "amountPaise": 200000, "amountDisplay": "₹2,000" },
    "paidThisCycle": { "amountPaise": 160000, "amountDisplay": "₹1,600" },
    "remainingThisCycle": { "amountPaise": 40000, "amountDisplay": "₹400" },
    "suggested": { "amountPaise": 40000, "amountDisplay": "₹400" },
    "positionVersion": 21,
    "expectedPositionVersion": 21,
    "paidMoneyNeverExpires": true,
    "unusedAllowanceCarriesForward": false
  }
}
```

### F.41 `GET /api/v1/app/schemes/:schemeId/passbook`

**Response (200):** `{ scheme, rows[], totals }` — row labels follow scheme `displayMode`.

### F.42 `GET /api/v1/app/schemes/:schemeId/settlement-preview?mode=CASH`

**Response (200):** CASH vs GOLD_WEIGHT + `modePreviews` — [MATRIX §5.5](./API_CONTRACT_CUSTOMER_MATRIX.md#55-get-appschemesschemeidsettlement-preview).

### F.43 `GET /api/v1/app/schemes/:schemeId`

**Response (200):** `CustomerSchemeDetail` — `progressCard` by mode, `payButton`, embedded `payableRange`, `redemption` — [MATRIX §5.6](./API_CONTRACT_CUSTOMER_MATRIX.md#56-get-appschemesschemeid--progresscard-by-displaymode).

### F.44 `POST /api/v1/app/schemes/enrol`

**Request:** `{ "planId", "payNow": true, "redirectUrl" }`

**Response (201):** FIXED → `paymentLink`; FLEXIBLE → `paymentIntent` — [MATRIX §5.7](./API_CONTRACT_CUSTOMER_MATRIX.md#57-post-appschemesenrol).

### F.45 `POST /api/v1/app/schemes/:schemeId/pay`

**Request:** `{ "amountPaise": 250000, "redirectUrl" }` (fixed only)

**Response (201):** `paymentLinkDto`

### F.46 `POST /api/v1/app/schemes/:schemeId/payment-intents`

**Request:**

```json
{
  "amountPaise": 40000,
  "targetCycle": "2026-09",
  "expectedPositionVersion": 21,
  "redirectUrl": "https://customer.example.com/pay/status"
}
```

**Response (201):** `paymentIntentAppDto`

### F.47 `POST /api/v1/app/schemes/:schemeId/pay/sdk-order`

Same as F.46; response includes `providerOrderId`.

### F.48 `GET /api/v1/app/payment-intents/:intentId`

**Response (200):** Intent + poll fields (`processing`, `paid`, `receipt`, …).

### F.49 `POST /api/v1/app/payment-intents/:intentId/cancel`

**Request:** `{ "expectedPositionVersion": 21 }`

**Response (200):** `paymentIntentCancelDto`

### F.50 `GET /api/v1/app/payments`

**Response (200):** `{ data: [ mapCustomerPaymentListItem ], meta: { summary, nextCursor, hasMore } }`

### F.51 `GET /api/v1/app/payments/:paymentId/receipt`

**Response:** PDF (`Content-Type: application/pdf`).

### F.52 `GET /api/v1/app/payments/:paymentId`

**Response (200):** Single payment list item.

### F.53 `GET /api/v1/app/payments/:linkId/status`

**Response (200):** `paymentPollStatusDto` (payment **link** id).

### F.54 `GET /api/v1/app/notifications`

**Response (200):** `{ items: [ mapCustomerNotification ], unreadCount }`

### F.55 `POST /api/v1/app/notifications/:id/read`

**Response (200):** `{ read: true }`

### F.56 `POST /api/v1/app/notifications/read-all`

**Response (200):** `{ updated: 5 }`

### F.57 `POST /api/v1/app/devices/fcm-token`

**Request:** `{ fcmToken, deviceId, platform: "android"|"ios" }`

**Response (200):** `{ registered: true, replacedPreviousToken: true }`

### F.58 `DELETE /api/v1/app/devices/fcm-token`

**Request:** `{ "deviceId" }` · **Response:** `{ removed: true }`

### F.59 `GET /api/v1/app/branches`

**Response (200):** Active branches array.

### F.60 `GET /api/v1/app/gold-rate/current`

**Response (200):** `{ ratePerGramPaise, ratePerGramDisplay, effectiveDate, purity }`

### F.61 `GET /api/v1/app/gold-rate/history`

**Response (200):** Rate history array (max 100).

### F.62 `POST /api/v1/app/grievances`

**Request:** `{ category, subject, description, attachmentUploadIds[] }`

**Response (201):** Grievance detail.

### F.63 `GET /api/v1/app/grievances`

**Response (200):** Paginated list.

### F.64 `GET /api/v1/app/grievances/:grievanceId`

**Response (200):** Detail + messages + `version`.

### F.65 `POST /api/v1/app/grievances/:grievanceId/messages`

**Request:** `{ body, expectedVersion, attachmentUploadIds[] }`

### F.66 `POST /api/v1/app/grievances/:grievanceId/reopen`

**Request:** `{ reason, expectedVersion }`

### F.67 `POST /api/v1/app/schemes/:schemeId/redemption-request`

**Request:**

```json
{
  "preferredMode": "GOLD_HANDOVER",
  "preferredDate": "2027-03-01",
  "remarks": "Prefer morning visit",
  "expectedVersion": 12
}
```

**Response (201):**

```json
{
  "success": true,
  "data": {
    "id": "red_01M33EXAMPLE",
    "schemeId": "sch_01M33R4NK7BGPJ32GGJKRFPJEH",
    "status": "REQUESTED",
    "preferredMode": "GOLD_HANDOVER",
    "preferredDate": "2027-03-01",
    "version": 13
  }
}
```

---

*Implementation: `customer-scheme-detail-dto.js`, `customer-app-dto.js`, `customer-notification-dto.js`, `customer-app.service.js`, `scheme.service.js`, `payment.service.js`, `redemption.service.js`. Response matrix: `API_CONTRACT_CUSTOMER_MATRIX.md`.*
