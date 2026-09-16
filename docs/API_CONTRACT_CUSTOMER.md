# Customer Web / App API Contract

**Audience:** Customer mobile app & customer web (`CUSTOMER`) + public pay/OTP surfaces

**Base:** `http://localhost:4000` · **Prefix:** `/api/v1` (except `/health*`)

> Money = integer **paise**. Weight = integer **mg**. Responses use **`id`** (not `_id`) on customer-facing DTOs where mapped.

## Scope

- Public: OTP, tenant resolve, pay links, app config
- App auth: `/app/auth/*` (refresh, logout, me)
- Customer app: all `/app/*` routes below
- Health checks

**Route count (this panel):** **59** — full list in [Appendix C](#appendix-c--route-inventory-customer-panel)

See also: [Full contract](./API_CONTRACT.md) · [Admin](./API_CONTRACT_ADMIN.md) · [Super Admin](./API_CONTRACT_SUPER_ADMIN.md)

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

### Schemes

| Method | Path | Notes |
|--------|------|--------|
| GET | `/schemes` | Query `group=PAST` for closed schemes with closure DTO |
| GET | `/schemes/:schemeId` | **`CustomerSchemeDetail`** (see Appendix A) — mapped in `customer-scheme-detail-dto.js`, not raw Mongo |
| GET | `/schemes/:schemeId/payable-range` | Query `targetCycle` (capped phase); enriched quote (see below) |
| GET | `/schemes/:schemeId/passbook` | Passbook rows |
| GET | `/schemes/:schemeId/settlement-preview` | Maturity preview with benefits, blockers, eligibility |
| POST | `/schemes/enrol` | Body: `{ planId, installmentAmountPaise?, payNow?, redirectUrl? }` only — plan decides first-instalment timing (customer cannot send `firstInstallmentMode`). Response discriminates `paymentType`: `FIXED_PAYMENT_LINK` \| `FLEXIBLE_PAYMENT_INTENT`. |
| POST | `/schemes/:schemeId/pay` | **Fixed schemes only** → payment link DTO. Flexible → `422 FLEXIBLE_PAYMENT_INTENT_REQUIRED`. |
| POST | `/schemes/:schemeId/payment-intents` | **Flexible only**; body `{ amountPaise, targetCycle?, expectedPositionVersion, redirectUrl? }` |
| POST | `/schemes/:schemeId/redemption-request` | Body: `{ preferredMode, preferredDate?, remarks?, expectedVersion }` → non-financial `REQUESTED` redemption |

**Payable range (example fields):**

```json
{
  "model": "FLEXIBLE",
  "phase": "CAPPED",
  "contributionIsOptional": true,
  "targetCycle": "2026-03",
  "minPayable": { "amountPaise": 50000, "amountDisplay": "₹500" },
  "maxPayable": { "amountPaise": 150000, "amountDisplay": "₹1,500" },
  "cycleCap": { "amountPaise": 200000, "amountDisplay": "₹2,000" },
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
| `FLEXIBLE_LOCK_WINDOW` | `FLEXIBLE_LOCK_WINDOW` | `cycleCap`, `remainingThisCycle`, locked average |

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

**Total: 59** (2 health + 17 public + 3 app auth + 37 app). Handlers: `src/routes/public.routes.js`, `src/routes/app-auth.routes.js`, `src/routes/app.routes.js`.

| # | Method | Path |
|---|--------|------|
| 1 | GET | `/health` |
| 2 | GET | `/health/ready` |
| 3 | GET | `/api/v1/public/app-config` |
| 4 | GET | `/api/v1/public/auth/password-policy` |
| 5 | POST | `/api/v1/public/auth/otp/request` |
| 6 | POST | `/api/v1/public/auth/otp/verify` |
| 7 | POST | `/api/v1/public/auth/set-password` |
| 8 | GET | `/api/v1/public/tenants/resolve` |
| 9 | GET | `/api/v1/public/tenants/:tenantId/branches` |
| 10 | POST | `/api/v1/public/signup/start` |
| 11 | POST | `/api/v1/public/signup/verify-otp` |
| 12 | GET | `/api/v1/public/signup/plans` |
| 13 | POST | `/api/v1/public/signup/:signupId/select-plan` |
| 14 | POST | `/api/v1/public/signup/:signupId/payment/initiate` |
| 15 | GET | `/api/v1/public/signup/:signupId/status` |
| 16 | GET | `/api/v1/public/signup/check-availability` |
| 17 | GET | `/api/v1/public/pay/:linkToken` |
| 18 | POST | `/api/v1/public/pay/:linkToken/initiate` |
| 19 | GET | `/api/v1/public/pay/:linkToken/status` |
| 20 | POST | `/api/v1/app/auth/refresh` |
| 21 | POST | `/api/v1/app/auth/logout` |
| 22 | GET | `/api/v1/app/auth/me` |
| 23 | GET | `/api/v1/app/auth/devices` |
| 24 | DELETE | `/api/v1/app/auth/devices/:deviceId` |
| 25 | GET | `/api/v1/app/home` |
| 26 | GET | `/api/v1/app/profile` |
| 27 | PATCH | `/api/v1/app/profile` |
| 28 | POST | `/api/v1/app/profile/complete` |
| 29 | PUT | `/api/v1/app/profile/kyc` |
| 30 | POST | `/api/v1/app/uploads/presign` |
| 31 | GET | `/api/v1/app/scheme-plans` |
| 32 | GET | `/api/v1/app/scheme-plans/:planId` |
| 33 | GET | `/api/v1/app/schemes` |
| 34 | GET | `/api/v1/app/schemes/:schemeId` |
| 35 | GET | `/api/v1/app/schemes/:schemeId/payable-range` |
| 36 | GET | `/api/v1/app/schemes/:schemeId/passbook` |
| 37 | GET | `/api/v1/app/schemes/:schemeId/settlement-preview` |
| 38 | POST | `/api/v1/app/schemes/enrol` |
| 39 | POST | `/api/v1/app/schemes/:schemeId/pay` |
| 40 | POST | `/api/v1/app/schemes/:schemeId/payment-intents` |
| 41 | POST | `/api/v1/app/schemes/:schemeId/redemption-request` |
| 42 | GET | `/api/v1/app/payment-intents/:intentId` |
| 43 | POST | `/api/v1/app/payment-intents/:intentId/cancel` |
| 44 | GET | `/api/v1/app/payments` |
| 45 | GET | `/api/v1/app/payments/:paymentId/receipt` |
| 46 | GET | `/api/v1/app/payments/:linkId/status` |
| 47 | GET | `/api/v1/app/notifications` |
| 48 | POST | `/api/v1/app/notifications/:id/read` |
| 49 | POST | `/api/v1/app/notifications/read-all` |
| 50 | POST | `/api/v1/app/devices/fcm-token` |
| 51 | DELETE | `/api/v1/app/devices/fcm-token` |
| 52 | GET | `/api/v1/app/branches` |
| 53 | GET | `/api/v1/app/gold-rate/current` |
| 54 | GET | `/api/v1/app/gold-rate/history` |
| 55 | POST | `/api/v1/app/grievances` |
| 56 | GET | `/api/v1/app/grievances` |
| 57 | GET | `/api/v1/app/grievances/:grievanceId` |
| 58 | POST | `/api/v1/app/grievances/:grievanceId/messages` |
| 59 | POST | `/api/v1/app/grievances/:grievanceId/reopen` |

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

---

*Implementation: `customer-scheme-detail-dto.js`, `customer-app-dto.js`, `customer-app.service.js`, `payment.service.js`.*
