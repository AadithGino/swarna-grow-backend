# Super Admin Panel API Contract

**Audience:** Platform / super-admin console (`PLATFORM_USER`) and public jeweller onboarding flows served by the same product surface.

**Base:** `http://localhost:4000` · **Prefix:** `/api/v1` (except `/health*`)

> Money = integer **paise**. Weight = integer **mg**.

**Implementation reference:** `src/routes/platform.routes.js`, `src/routes/public.routes.js`, `src/services/platform.service.js`, `src/services/signup.service.js`

## Scope

- All `/platform/*` routes
- Platform auth: `/platform/auth/login|refresh|logout`
- Public jeweller signup: `/public/signup/*`, `/public/signup/plans`, availability
- Public owner setup: `/public/auth/set-password`, `/public/auth/password-policy`
- Health checks
- Platform webhook-failure ops

**Route count in this panel:** 52

See also: [Full contract](./API_CONTRACT.md) · [Admin](./API_CONTRACT_ADMIN.md) · [Customer](./API_CONTRACT_CUSTOMER.md)

## Conventions

**Success**

```json
{
  "success": true,
  "data": {},
  "meta": {
    "nextCursor": "string|null",
    "hasMore": false,
    "limit": 20
  }
}
```

List routes return `meta.hasMore` and `meta.nextCursor` when cursor pagination applies. Omit `meta` when empty.

**Error**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "...",
    "details": [],
    "traceId": "uuid"
  }
}
```

`details` may be a field list (`{ field, message }`) or structured objects (e.g. go-live checklist items `{ key, message }`, downgrade guard `{ limitKey, used, targetLimit }`).

**Headers:** `Authorization: Bearer <token>`, `X-Idempotency-Key: <uuid>` on mutating routes, `Content-Type: application/json`

**Subjects:** `PLATFORM_USER` → `/platform/*` · `TENANT_USER` → `/admin/*`, `/staff/*` · `CUSTOMER` → `/app/*`

**Identifiers:** Response bodies use **`id`** (not `_id`). Prefixes: `pusr_` platform user, `tnt_` tenant, `brn_` branch, `usr_` tenant user, `sgn_` signup, `sgt_` signup token, `spt_` setup password token, `splan_` subscription plan, `inv_` invoice, `psn_` payment session, `aud_` audit.

**Naming:** Tenant-facing strings use `businessName`, `displayName`, `tenantCode` (not bare `code` / `name` in API DTOs). Internal storage may differ; serializers map to these fields.

**Token TTL:** `expiresIn` on auth responses is an **integer number of seconds** (not a string like `"30m"`).

**Optimistic concurrency:** `expectedVersion` (integer) is **required** on `PATCH /platform/tenants/:tenantId`, `PATCH /platform/subscription-plans/:planId`, and `PATCH /platform/tenants/:tenantId/subscription/limits`. Mismatch → `409` / `VERSION_CONFLICT`.

**Idempotency** (24-hour retention):

| Outcome | HTTP | Code |
|---|---|---|
| Same key + same body (completed) | replay stored status/body | — (header `X-Idempotent-Replay: true`) |
| Same key + different body | 409 | `IDEMPOTENCY_KEY_REUSED` |
| Same key, request still processing | 409 | `REQUEST_IN_PROGRESS` |

**Signup token (`sgt_`):** Issued after OTP verify. Required as `Authorization: Bearer <signupToken>` on plan selection, payment initiation, and status polling once OTP is verified. Not a JWT — opaque token matched server-side (~60 minutes).

**Template registry:** Eight **required** tenant template types (`templatesRequired: 8`): `OTP`, `SCHEME_JOINED`, `PAYMENT_DUE`, `PAYMENT_OVERDUE`, `PAYMENT_SUCCESS`, `FLEXI_LOCK_APPLIED`, `SCHEME_MATURED`, `SCHEME_CLOSED`. Optional: `PAYMENT_SUCCESS_TEXT_FALLBACK`. `PAYMENT_DUE` and `PAYMENT_OVERDUE` apply only to **fixed mandatory installments**, not optional flexible-window contributions.

**Integration secrets:** WhatsApp and PhonePe credential fields are **write-only**. Responses expose masked values and verification status only; secrets are never returned after save.

**Tenant roles (tenant users only):** `TENANT_OWNER` · `TENANT_ADMIN` · `BRANCH_MANAGER` · `BRANCH_STAFF` · `COLLECTION_AGENT` (field cash collector; see [Collection agent app contract](./API_CONTRACT_STAFF.md))

### Shared DTOs

**MoneyRef**

```json
{ "amountPaise": 500000, "amountDisplay": "₹5,000" }
```

**Subscription plan (platform list / detail / public plans)**

```json
{
  "id": "splan_growth",
  "tier": "STARTER|GROWTH|PRO|CUSTOM",
  "name": "Growth",
  "displayName": "Growth",
  "monthlyPrice": { "amountPaise": 500000, "amountDisplay": "₹5,000" },
  "yearlyPrice": { "amountPaise": 5400000, "amountDisplay": "₹54,000" },
  "priceLabel": "Contact Us",
  "trialDays": 14,
  "highlighted": true,
  "sortOrder": 2,
  "limits": {
    "activeCustomers": 1000,
    "branches": 2,
    "staffSeats": 10,
    "schemePlans": 10,
    "whatsappMessagesPerMonth": 5000,
    "storageMb": 2048
  },
  "features": {
    "multiBranch": true,
    "customApp": false,
    "flexibleScheme": true,
    "goldWeightScheme": true,
    "prematureRedemption": true,
    "customerSelfEnrol": true,
    "advancedReports": false
  },
  "displayFeatures": [{ "label": "Active customers", "value": "1,000" }],
  "tenantCount": 17,
  "status": "ACTIVE|DEPRECATED"
}
```

`limits.*` = `null` means unlimited (typical for `CUSTOM`). Public `GET /public/signup/plans` omits `tenantCount`.

**ChartSeries** (`GET /platform/dashboard/charts/:chartKey`)

```json
{
  "chartType": "line|bar|stackedBar|area|donut|horizontalBar",
  "title": "Tenant growth",
  "xAxis": { "type": "category", "label": "Period" },
  "yAxis": { "type": "currency|weight|count|percent", "label": "Amount", "unit": "INR|count" },
  "series": [
    {
      "key": "TENANTS",
      "name": "New tenants",
      "data": [{ "x": "2026-09", "y": 4, "yDisplay": "4" }]
    }
  ],
  "summary": {}
}
```

**Supported chart keys:** `tenant-growth`, `mrr-trend`, `platform-collection-volume`, `whatsapp-volume`, `tier-distribution` (alias `subscription-distribution` accepted).

**Platform feature flags (canonical keys only)**

`customerSelfEnrol` · `flexibleScheme` · `passbookImageOnPayment` · `onlinePayments` · `staffAppEnabled` · `customerAppEnabled`

Effective feature = **subscription tier feature AND platform flag** (flags may disable, never grant beyond tier).

Plan create uses `supportedBillingCycles: ["MONTHLY", "ANNUAL"]` (not a single `billingCycle`). Tenant signup / change-plan uses `billingCycle`.

**TenantDetail** (`GET /platform/tenants/:tenantId`)

```json
{
  "id": "tnt_...",
  "tenantCode": "SREEGOLD",
  "businessName": "Sree Gold Jewellery",
  "displayName": "Sree Gold",
  "gstin": "32ABCDE1234F1Z5",
  "address": "42 MG Road",
  "city": "Kochi",
  "supportNumber": "+919846543211",
  "ownerEmail": "mahesh@sreegold.in",
  "status": "ACTIVE",
  "goLiveAt": "ISO|null",
  "branding": { "logoUrl": null, "primaryColor": "#7B1E1E", "accentColor": "#C9A227", "displayName": "Sree Gold" },
  "settings": { "multiSchemePerCustomer": true, "kycMandatory": false, "customerSelfEnrolEnabled": true },
  "subscription": {
    "tier": "GROWTH",
    "status": "ACTIVE",
    "billingCycle": "MONTHLY",
    "currentPeriodStart": "2026-09-01",
    "currentPeriodEnd": "2026-10-01",
    "limits": { "activeCustomers": 1000, "branches": 2, "staffSeats": 10, "schemePlans": 10, "whatsappMessagesPerMonth": 5000 },
    "limitOverrides": {},
    "features": { "multiBranch": true, "flexibleScheme": true, "customerSelfEnrol": true }
  },
  "integrations": {
    "whatsapp": { "configured": true, "provider": "META_CLOUD", "phoneNumberDisplay": "...", "accessTokenMasked": "••••", "lastVerifiedAt": "ISO" },
    "paymentGateway": { "configured": true, "clientCredentialsConfigured": true, "provider": "PHONEPE", "clientIdMasked": "SREE••••SDK", "environment": "PRODUCTION", "lastVerifiedAt": "ISO" }
  },
  "templates": { "configured": 7, "required": 8, "missing": ["SCHEME_CLOSED"] },
  "usage": {
    "activeCustomers": { "used": 412, "limit": 1000, "percent": 41.2 },
    "whatsappMessages": { "used": 1840, "limit": 5000, "percent": 36.8, "resetsOn": "2026-10-01" }
  },
  "branches": [{ "id": "brn_...", "name": "Main Showroom", "code": "MAIN", "status": "ACTIVE" }],
  "owner": { "id": "usr_...", "name": "Mahesh Kumar", "mobile": "+919846543210", "email": "mahesh@sreegold.in" },
  "stats": { "totalSchemes": 518, "activeSchemes": 431 },
  "audit": { "createdAt": "ISO", "version": 12 }
}
```

**TenantTemplateRegistration** (`GET /platform/tenants/:tenantId/templates` item)

```json
{
  "id": "tpl_...",
  "messageType": "PAYMENT_DUE",
  "templateName": "sreegold_payment_due_v1",
  "templateId": "1234567890123456",
  "languageCode": "en",
  "variableOrder": ["customerName", "schemeName", "installmentNumber", "amountDisplay", "dueDateDisplay", "jewellerName"],
  "buttonUrlVariableKey": "paymentLinkToken",
  "approvalStatus": "APPROVED",
  "notes": "Approved 12 Sep",
  "active": true,
  "version": 2
}
```

**WebhookFailureRow** (`GET /platform/webhook-failures` item)

```json
{
  "id": "whk_...",
  "tenantId": "tnt_...|null",
  "provider": "PHONEPE|WHATSAPP",
  "providerEventId": "string",
  "status": "FAILED|SIGNATURE_FAILED|DEAD_LETTER",
  "attempts": 3,
  "lastError": "string|null",
  "traceId": "uuid|null",
  "retryEligible": true,
  "payloadReference": "providerEventId",
  "createdAt": "ISO",
  "processedAt": "ISO|null"
}
```

Plan create/update validators: `src/validators/common.validators.js`

---

## Endpoints

### Health

#### `GET /health`

- **Auth:** none
- **Idempotent:** no
- **Response (200):**

```json
{
  "success": true,
  "data": { "status": "ok", "timestamp": "ISO" }
}
```

#### `GET /health/ready`

- **Auth:** none
- **Idempotent:** no
- **Response (200):**

```json
{
  "success": true,
  "data": { "database": "ready", "queue": "ready", "workers": "ready" }
}
```

### Public

#### `GET /api/v1/public/auth/password-policy`

- **Auth:** none (public rate limit)
- **Idempotent:** no
- **Response (200):**

```json
{
  "success": true,
  "data": {
    "minLength": 8,
    "requireUppercase": true,
    "requireLowercase": true,
    "requireNumber": true,
    "requireSymbol": true
  }
}
```

#### `GET /api/v1/public/signup/check-availability`

- **Auth:** none (public rate limit)
- **Query:** `mobile?` · `tenantCode?` (at least one)
- **Idempotent:** no
- **Response (200):**

```json
{
  "success": true,
  "data": {
    "available": false,
    "reason": "MOBILE_ALREADY_REGISTERED|TENANT_CODE_TAKEN"
  }
}
```

`reason` omitted when `available` is true.

#### `GET /api/v1/public/signup/plans`

- **Auth:** none (public rate limit)
- **Idempotent:** no
- **Response (200):** `data` = array of subscription plan DTOs (public-safe; no `tenantCount`), sorted by `sortOrder`.

#### `GET /api/v1/public/signup/:signupId/status`

- **Auth:** none while `stage` is `OTP_PENDING`; **Bearer signup token required** after OTP verify (protects `setPasswordToken`)
- **Path params:** `signupId`
- **Idempotent:** no
- **Response (200):**

```json
{
  "success": true,
  "data": {
    "signupId": "sgn_...",
    "stage": "OTP_PENDING|PLAN_PENDING|PAYMENT_PENDING|PAYMENT_PROCESSING|COMPLETED|FAILED",
    "paymentStatus": "PENDING|SUCCESS|FAILED|null",
    "tenant": { "id": "tnt_...", "tenantCode": "SREEGOLD", "status": "PENDING_SETUP" },
    "ownerLogin": {
      "mobile": "+919846543210",
      "passwordSetRequired": true,
      "setPasswordToken": "spt_..."
    },
    "message": "Your account is created..."
  }
}
```

`setPasswordToken` returned once on first completed status poll, then cleared. In mock payment mode, provisioning may complete on status poll.

#### `POST /api/v1/public/auth/set-password`

- **Auth:** none (public rate limit)
- **Idempotent:** no
- **Request body (owner first login — preferred):**

```json
{
  "token": "spt_...",
  "password": "MyStr0ng#Pass",
  "confirmPassword": "MyStr0ng#Pass"
}
```

- **Request body (OTP password reset — alternate):**

```json
{
  "resetToken": "opaque>=32chars",
  "password": "MyStr0ng#Pass"
}
```

- **Response (200) owner setup — full session:**

```json
{
  "success": true,
  "data": {
    "passwordSet": true,
    "mustChangePassword": false,
    "user": {
      "id": "usr_...",
      "name": "Mahesh Kumar",
      "role": "TENANT_OWNER",
      "tenantId": "tnt_...",
      "branchId": "brn_..."
    },
    "accessToken": "jwt",
    "refreshToken": "opaque",
    "expiresIn": 1800,
    "tokenType": "Bearer"
  }
}
```

- **Response (200) reset-only:**

```json
{
  "success": true,
  "data": { "id": "usr_...", "passwordSet": true }
}
```

#### `POST /api/v1/public/signup/start`

- **Auth:** none (public rate limit)
- **Idempotent:** yes
- **Request body:**

```json
{
  "businessName": "Sree Gold Jewellery",
  "ownerName": "Mahesh Kumar",
  "mobile": "+919846543210",
  "email": "mahesh@sreegold.in",
  "city": "Kochi"
}
```

- **Response (201):**

```json
{
  "success": true,
  "data": {
    "signupId": "sgn_...",
    "otpSent": true,
    "otpChannel": "WHATSAPP",
    "maskedMobile": "9846XXXX10",
    "expiresInSeconds": 300,
    "resendAvailableInSeconds": 30
  }
}
```

Server derives unique `tenantCode` from `businessName` (not supplied by client).

#### `POST /api/v1/public/signup/verify-otp`

- **Auth:** none (public rate limit)
- **Idempotent:** yes
- **Request body:**

```json
{ "signupId": "sgn_...", "otp": "482913" }
```

- **Response (200):**

```json
{
  "success": true,
  "data": {
    "signupId": "sgn_...",
    "verified": true,
    "signupToken": "sgt_...",
    "nextStep": "SELECT_PLAN"
  }
}
```

`signupToken` authorises remaining signup steps (`Authorization: Bearer sgt_...`), ~60 minutes, not a full session.

#### `POST /api/v1/public/signup/:signupId/select-plan`

- **Auth:** **Bearer signup token required** (public rate limit)
- **Path params:** `signupId`
- **Idempotent:** yes
- **Request body:**

```json
{
  "subscriptionPlanId": "splan_growth",
  "billingCycle": "MONTHLY|ANNUAL"
}
```

- **Response (200):**

```json
{
  "success": true,
  "data": {
    "selectedPlan": { "tier": "GROWTH", "name": "Growth" },
    "amount": { "amountPaise": 500000, "amountDisplay": "₹5,000" },
    "tax": { "amountPaise": 90000, "amountDisplay": "₹900" },
    "total": { "amountPaise": 590000, "amountDisplay": "₹5,900" },
    "trialDays": 14,
    "nextStep": "PAYMENT"
  }
}
```

#### `POST /api/v1/public/signup/:signupId/payment/initiate`

- **Auth:** **Bearer signup token required** (public rate limit)
- **Path params:** `signupId`
- **Idempotent:** yes
- **Request body:**

```json
{ "redirectUrl": "https://app.example.com/signup/complete" }
```

- **Response (200):**

```json
{
  "success": true,
  "data": {
    "paymentSessionId": "psn_...",
    "redirectUrl": "https://mercury.phonepe.com/transact/pg?token=...",
    "expiresAt": "ISO"
  }
}
```

### Platform

#### `POST /api/v1/platform/auth/login`

- **Auth:** none
- **Idempotent:** no
- **Request body:**

```json
{
  "email": "ops@platform.com",
  "password": "string>=8",
  "deviceId": "string>=4?",
  "platform": "web|android|ios?"
}
```

- **Response (200):**

```json
{
  "success": true,
  "data": {
    "accessToken": "jwt",
    "refreshToken": "opaque",
    "expiresIn": 1800,
    "tokenType": "Bearer",
    "user": {
      "id": "pusr_...",
      "name": "Ops Admin",
      "email": "ops@platform.com",
      "role": "SUPER_ADMIN",
      "permissions": ["*"]
    }
  }
}
```

No `tenantId` or `branchId` on platform user.

#### `POST /api/v1/platform/auth/refresh`

- **Auth:** none
- **Request body:** `{ "refreshToken": "string" }`
- **Response (200):** `{ accessToken, refreshToken, expiresIn, tokenType }`

#### `POST /api/v1/platform/auth/logout`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body:** `{ "refreshToken": "string?" }`
- **Response (200):** `{ "loggedOut": true }`

#### `GET /api/v1/platform/dashboard/summary`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** no
- **Response (200):**

```json
{
  "success": true,
  "data": {
    "tenants": { "total": 67, "active": 61, "pendingSetup": 4, "suspended": 2 },
    "tenantsByTier": [{ "tier": "GROWTH", "count": 17 }],
    "mrr": { "amountPaise": 27400000, "amountDisplay": "₹2,74,000" },
    "platformVolume": {
      "collectionThisMonth": { "amountPaise": 8420000000, "amountDisplay": "₹8,42,00,000" },
      "activeCustomersTotal": 18420,
      "activeSchemesTotal": 21055
    },
    "whatsapp": {
      "sentThisMonth": 142800,
      "failedThisMonth": 5140,
      "deliveryRatePercent": 96.4
    },
    "alerts": [
      { "severity": "HIGH", "key": "WEBHOOK_FAILURES", "message": "...", "count": 18 }
    ]
  }
}
```

#### `GET /api/v1/platform/dashboard/charts/:chartKey`

- **Auth:** Bearer `PLATFORM_USER`
- **Path params:** `chartKey` ∈ `tenant-growth` · `mrr-trend` · `platform-collection-volume` · `whatsapp-volume` · `tier-distribution`
- **Response (200):** ChartSeries object in `data`

#### `GET /api/v1/platform/subscription-plans`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** no
- **Response (200):** `data` = array of subscription plan DTOs with `tenantCount`

#### `GET /api/v1/platform/subscription-plans/:planId`

- **Auth:** Bearer `PLATFORM_USER`
- **Path params:** `planId` (e.g. `splan_growth`)
- **Response (200):** single subscription plan DTO

#### `POST /api/v1/platform/subscription-plans`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body:**

```json
{
  "tier": "STARTER|GROWTH|PRO|CUSTOM",
  "name": "Growth",
  "displayName": "Growth",
  "monthlyPricePaise": 500000,
  "yearlyPricePaise": 5400000,
  "trialDays": 14,
  "highlighted": true,
  "sortOrder": 2,
  "supportedBillingCycles": ["MONTHLY", "ANNUAL"],
  "limits": {
    "activeCustomers": 1000,
    "branches": 2,
    "staffSeats": 10,
    "schemePlans": 10,
    "whatsappMessagesPerMonth": 5000
  },
  "features": {
    "multiBranch": true,
    "customApp": false,
    "flexibleScheme": true,
    "goldWeightScheme": true,
    "prematureRedemption": true,
    "customerSelfEnrol": true,
    "advancedReports": false
  },
  "displayFeatures": [],
  "active": true
}
```

`expectedVersion` **not** required on create.

- **Response (201):** subscription plan DTO

#### `PATCH /api/v1/platform/subscription-plans/:planId`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body:** partial plan fields + **`expectedVersion` required**
- **Response (200):** subscription plan DTO

#### `POST /api/v1/platform/subscription-plans/:planId/deprecate`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Response (200):** plan DTO with `status: "DEPRECATED"`

#### `GET /api/v1/platform/tenants`

- **Auth:** Bearer `PLATFORM_USER`
- **Query:** `status` · `tier` · `q` (name/mobile/city/code) · `setupPending=true` · `limit` · `cursor`
- **Response (200):**

```json
{
  "success": true,
  "data": [
    {
      "id": "tnt_...",
      "businessName": "Sree Gold Jewellery",
      "displayName": "Sree Gold",
      "ownerName": "Mahesh Kumar",
      "ownerMobile": "+919846543210",
      "city": "Kochi",
      "status": "ACTIVE|PENDING_SETUP|SUSPENDED|CANCELLED",
      "subscription": {
        "tier": "GROWTH",
        "status": "ACTIVE|TRIAL|...",
        "currentPeriodEnd": "2026-10-01",
        "daysRemaining": 17
      },
      "provisioning": {
        "whatsappConfigured": true,
        "paymentGatewayConfigured": true,
        "templatesConfigured": 7,
        "templatesRequired": 8,
        "readyToGoLive": false
      },
      "usage": {
        "activeCustomers": 412,
        "branches": 2,
        "staff": 6,
        "whatsappUsedThisMonth": 1840
      },
      "createdAt": "ISO"
    }
  ],
  "meta": { "nextCursor": "...", "hasMore": true, "limit": 20 }
}
```

#### `POST /api/v1/platform/tenants`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body:**

```json
{
  "businessName": "Sree Gold Jewellery",
  "displayName": "Sree Gold",
  "ownerName": "Mahesh Kumar",
  "ownerMobile": "+919846543210",
  "ownerEmail": "mahesh@sreegold.in",
  "city": "Kochi",
  "address": "42 MG Road, Kochi 682011",
  "supportNumber": "+919846543211",
  "subscriptionPlanId": "splan_growth",
  "billingCycle": "MONTHLY|ANNUAL",
  "trialDays": 14,
  "skipPayment": true,
  "createDefaultBranch": true,
  "defaultBranchName": "Main Showroom",
  "sendWelcomeMessage": true
}
```

Do **not** send `temporaryPassword`; server generates it once.

Legacy aliases accepted: `name`, `mobile`, `email`, `code`, `headOfficeName`.

- **Response (201):**

```json
{
  "success": true,
  "data": {
    "tenant": {
      "id": "tnt_...",
      "businessName": "Sree Gold Jewellery",
      "tenantCode": "SREEGOLD",
      "status": "PENDING_SETUP",
      "subscription": { "tier": "GROWTH", "status": "TRIAL", "trialEndsAt": "ISO" }
    },
    "ownerUser": {
      "id": "usr_...",
      "name": "Mahesh Kumar",
      "mobile": "+919846543210",
      "role": "TENANT_OWNER",
      "temporaryPassword": "Gd7#kP2wQx",
      "mustChangePassword": true
    },
    "defaultBranch": { "id": "brn_...", "name": "Main Showroom", "code": "MAIN" },
    "nextSteps": [
      { "key": "WHATSAPP_CREDENTIALS", "done": false },
      { "key": "PAYMENT_GATEWAY", "done": false },
      { "key": "WHATSAPP_TEMPLATES", "done": false },
      { "key": "GO_LIVE", "done": false }
    ],
    "welcomeMessageQueued": true
  }
}
```

#### `GET /api/v1/platform/tenants/:tenantId`

- **Auth:** Bearer `PLATFORM_USER`
- **Response (200):** `data` = **TenantDetail** (see shared DTOs): profile, branding, settings, owner, subscription periods, limits, overrides, integrations, template status, branches, statistics, audit summary (`version`).

#### `PATCH /api/v1/platform/tenants/:tenantId`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body (partial):**

```json
{
  "businessName": "string",
  "displayName": "string",
  "ownerEmail": "string",
  "supportNumber": "string",
  "gstin": "string",
  "city": "string",
  "address": "string",
  "tenantCode": "SREEGOLD",
  "branding": {},
  "settings": {},
  "expectedVersion": 12
}
```

`expectedVersion` **required**. `tenantCode` editable only before go-live.

- **Response (200):** same shape as `GET .../tenants/:tenantId`

#### `POST /api/v1/platform/tenants/:tenantId/suspend`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body:** `{ "reason": "string?", "notifyOwner": true? }`
- **Response (200):**

```json
{
  "success": true,
  "data": {
    "id": "tnt_...",
    "status": "SUSPENDED",
    "suspendedAt": "ISO",
    "effects": {
      "tenantWritesBlocked": true,
      "readsAllowed": true,
      "reminderJobsStopped": true,
      "tenantApiErrorCode": "SUBSCRIPTION_INACTIVE"
    }
  }
}
```

**Suspension behaviour:** tenant-scoped **writes** are rejected with `SUBSCRIPTION_INACTIVE`; **reads** remain available. Reminder / outbound WhatsApp jobs for the tenant stop until reactivation.

#### `POST /api/v1/platform/tenants/:tenantId/reactivate`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Response (200):**

```json
{
  "success": true,
  "data": {
    "id": "tnt_...",
    "status": "ACTIVE",
    "reactivatedAt": "ISO",
    "effects": { "tenantWritesBlocked": false, "reminderJobsStopped": false }
  }
}
```

#### `POST /api/v1/platform/tenants/:tenantId/go-live`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Response (200):**

```json
{
  "success": true,
  "data": {
    "ok": true,
    "checklist": [
      { "key": "WHATSAPP_CREDENTIALS", "done": true },
      { "key": "PAYMENT_GATEWAY", "done": true },
      { "key": "WHATSAPP_TEMPLATES", "done": true },
      { "key": "GO_LIVE", "done": true }
    ],
    "tenant": { "id": "tnt_...", "status": "ACTIVE", "goLiveAt": "ISO" }
  }
}
```

- **Response (422):** `VALIDATION_FAILED` with `details: [{ "key": "WHATSAPP_TEMPLATES", "message": "..." }]`

#### `POST /api/v1/platform/tenants/:tenantId/owner-credentials`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body:** `{}` or `{ "temporaryPassword": "string?" }` (optional; server generates if omitted)
- **Response (200):**

```json
{
  "success": true,
  "data": {
    "ownerId": "usr_...",
    "temporaryPassword": "Gd7#kP2wQx",
    "mustSetPassword": true,
    "mustChangePassword": true
  }
}
```

#### `GET /api/v1/platform/tenants/:tenantId/usage`

- **Auth:** Bearer `PLATFORM_USER`
- **Response (200):**

```json
{
  "success": true,
  "data": {
    "activeCustomers": { "used": 412, "limit": 1000, "percentage": 41.2 },
    "branches": { "used": 2, "limit": 2, "percentage": 100 },
    "staff": { "used": 6, "limit": 10, "percentage": 60 },
    "schemePlans": { "used": 4, "limit": 10, "percentage": 40 },
    "whatsappMessages": {
      "used": 1840,
      "limit": 5000,
      "percentage": 36.8,
      "resetDate": "2026-10-01"
    }
  }
}
```

#### `GET /api/v1/platform/tenants/:tenantId/flags`

- **Auth:** Bearer `PLATFORM_USER`
- **Response (200):**

```json
{
  "success": true,
  "data": {
    "flags": { "customerSelfEnrol": true, "onlinePayments": true },
    "effectiveFlags": { "customerSelfEnrol": true, "onlinePayments": true }
  }
}
```

#### `PUT /api/v1/platform/tenants/:tenantId/flags`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body:**

```json
{
  "flags": {
    "customerSelfEnrol": true,
    "flexibleScheme": true,
    "passbookImageOnPayment": true,
    "onlinePayments": false,
    "staffAppEnabled": true,
    "customerAppEnabled": true
  },
  "reason": "Disabling online payments while gateway KYC is pending"
}
```

- **Response (200):**

```json
{
  "success": true,
  "data": {
    "flags": { "customerSelfEnrol": true, "onlinePayments": false },
    "effectiveFlags": { "customerSelfEnrol": true, "onlinePayments": false },
    "version": 13
  }
}
```

#### `PUT /api/v1/platform/tenants/:tenantId/integrations/whatsapp`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body (Meta Cloud API — write-only secrets):**

```json
{
  "provider": "META_CLOUD",
  "phoneNumberId": "string",
  "businessAccountId": "string",
  "accessToken": "string",
  "appSecret": "string",
  "verifyToken": "string",
  "environment": "PRODUCTION|SANDBOX",
  "callbackUrlOverride": "string|null"
}
```

`environment` is optional; when omitted, server default applies.

- **Response (200):**

```json
{
  "success": true,
  "data": {
    "configured": true,
    "provider": "META_CLOUD",
    "phoneNumberDisplay": "+91 98465 43210",
    "accessTokenMasked": "EAA••••xyz",
    "verificationStatus": "PENDING|VERIFIED|FAILED",
    "version": 4
  }
}
```

No plaintext secrets in responses.

#### `POST /api/v1/platform/tenants/:tenantId/integrations/whatsapp/verify`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body:** `{ "testMobile": "+919846543210" }`
- **Response (200):** `{ verificationStatus, messageId, deliveryStatus, verifiedAt, testMobile }`

#### `PUT /api/v1/platform/tenants/:tenantId/integrations/payment-gateway`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body:**

```json
{
  "provider": "PHONEPE",
  "clientId": "string",
  "clientSecret": "string",
  "clientVersion": 1,
  "webhookUsername": "string",
  "webhookPassword": "string",
  "environment": "PRODUCTION|SANDBOX"
}
```

`clientVersion` is an **integer**. Webhook username/password must match the jeweller's PhonePe
dashboard Webhooks tab. Register webhook URL once per tenant:
`{PUBLIC_BASE_URL}/api/v1/webhooks/phonepe/{tenantId}`.

- **Response (200):**

```json
{
  "success": true,
  "data": {
    "configured": true,
    "clientCredentialsConfigured": true,
    "provider": "PHONEPE",
    "clientIdMasked": "SREE••••SDK",
    "environment": "PRODUCTION",
    "verificationStatus": "PENDING|VERIFIED|FAILED",
    "version": 2
  }
}
```

#### `POST /api/v1/platform/tenants/:tenantId/integrations/payment-gateway/verify`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Response (200):** `{ verified, verificationStatus, verifiedAt }`

#### `GET /api/v1/platform/template-definitions`

- **Auth:** Bearer `PLATFORM_USER`
- **Response (200):**

```json
{
  "success": true,
  "data": [
    {
      "messageType": "OTP",
      "label": "Login OTP",
      "required": true,
      "variables": [
        { "index": 1, "key": "otpCode", "sample": "482913" },
        { "index": 2, "key": "validMinutes", "sample": "5" },
        { "index": 3, "key": "jewellerName", "sample": "Sree Gold" }
      ]
    },
    {
      "messageType": "PAYMENT_DUE",
      "label": "Payment due reminder",
      "required": true,
      "installmentScope": "FIXED_MANDATORY_INSTALLMENTS_ONLY",
      "hasUrlButton": true,
      "variables": [
        { "index": 1, "key": "customerName", "sample": "Anjali Menon" },
        { "index": 2, "key": "schemeName", "sample": "Swarna Plus 11" },
        { "index": 3, "key": "installmentNumber", "sample": "4" },
        { "index": 4, "key": "amountDisplay", "sample": "₹5,000" },
        { "index": 5, "key": "dueDateDisplay", "sample": "20 Sep 2026" },
        { "index": 6, "key": "jewellerName", "sample": "Sree Gold" }
      ],
      "buttonUrlVariable": { "index": 1, "key": "paymentLinkToken", "sample": "pl_8f2a4c60" }
    },
    {
      "messageType": "PAYMENT_SUCCESS",
      "label": "Payment success with passbook",
      "required": true,
      "hasMediaHeader": true,
      "mediaHeaderType": "IMAGE",
      "variables": [
        { "index": 1, "key": "customerName", "sample": "Anjali Menon" },
        { "index": 2, "key": "amountDisplay", "sample": "₹5,000" },
        { "index": 3, "key": "schemeName", "sample": "Swarna Plus 11" },
        { "index": 4, "key": "receiptNumber", "sample": "SG/MGR/2026/001284" },
        { "index": 5, "key": "paidInstallments", "sample": "4 of 11" },
        { "index": 6, "key": "jewellerName", "sample": "Sree Gold" }
      ]
    },
    {
      "messageType": "PAYMENT_SUCCESS_TEXT_FALLBACK",
      "label": "Payment success (text fallback)",
      "required": false,
      "variables": [
        { "index": 1, "key": "customerName", "sample": "Anjali Menon" },
        { "index": 2, "key": "amountDisplay", "sample": "₹5,000" },
        { "index": 3, "key": "schemeName", "sample": "Swarna Plus 11" },
        { "index": 4, "key": "receiptNumber", "sample": "SG/MGR/2026/001284" },
        { "index": 5, "key": "paidInstallments", "sample": "4 of 11" },
        { "index": 6, "key": "jewellerName", "sample": "Sree Gold" }
      ]
    }
  ],
  "meta": { "nextCursor": null, "hasMore": false, "limit": 9 }
}
```

Full list (8 required + 1 optional): `OTP`, `SCHEME_JOINED`, `PAYMENT_DUE`, `PAYMENT_OVERDUE`, `PAYMENT_SUCCESS`, `FLEXI_LOCK_APPLIED`, `SCHEME_MATURED`, `SCHEME_CLOSED`, optional `PAYMENT_SUCCESS_TEXT_FALLBACK`. Canonical definitions: `src/constants/template-registry.js`

#### `GET /api/v1/platform/tenants/:tenantId/templates`

- **Auth:** Bearer `PLATFORM_USER`
- **Response (200):** `data` = array of **TenantTemplateRegistration** items

#### `PUT /api/v1/platform/tenants/:tenantId/templates/:messageType`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body:**

```json
{
  "templateName": "sreegold_payment_due_v1",
  "templateId": "1234567890123456",
  "languageCode": "en",
  "variableOrder": ["customerName", "schemeName", "installmentNumber", "amountDisplay", "dueDateDisplay", "jewellerName"],
  "buttonUrlVariableKey": "paymentLinkToken",
  "approvalStatus": "APPROVED",
  "notes": "Approved 12 Sep"
}
```

Mismatch vs platform definition → `400` with missing/extra variable keys.

#### `DELETE /api/v1/platform/tenants/:tenantId/templates/:messageType`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Response (200):** `{ "deleted": true }`

#### `POST /api/v1/platform/tenants/:tenantId/templates/:messageType/test`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body:**

```json
{ "testMobile": "+919846543210" }
```

Legacy alias: `mobile` (same value as `testMobile`; do not send both).

- **Response (202):**

```json
{
  "success": true,
  "data": { "queued": true, "to": "+919846543210", "templateId": "1234567890123456", "messageId": "wamid...." }
}
```

#### `POST /api/v1/platform/tenants/:tenantId/subscription/change-plan`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body:**

```json
{
  "subscriptionPlanId": "splan_pro",
  "billingCycle": "MONTHLY|ANNUAL",
  "effectiveFrom": "IMMEDIATE",
  "generateInvoice": true,
  "reason": "Upgrade requested by owner on call"
}
```

Legacy: `planId` accepted as alias for `subscriptionPlanId`.

- **Response (422) downgrade guard:**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Current usage exceeds the target plan's limits.",
    "details": [{ "limitKey": "activeCustomers", "used": 1420, "targetLimit": 1000 }]
  }
}
```

#### `PATCH /api/v1/platform/tenants/:tenantId/subscription/limits`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body (CUSTOM tier only):**

```json
{
  "limitOverrides": {
    "activeCustomers": 8000,
    "branches": 12,
    "whatsappMessagesPerMonth": 50000
  },
  "featureOverrides": { "customApp": true, "advancedReports": true },
  "reason": "Negotiated enterprise terms",
  "expectedVersion": 12
}
```

`expectedVersion` **required** (CUSTOM tier only).

- **Response (200):**

```json
{
  "success": true,
  "data": {
    "tier": "CUSTOM",
    "limitOverrides": { "activeCustomers": 8000 },
    "featureOverrides": { "customApp": true },
    "version": 13
  }
}
```

#### `POST /api/v1/platform/tenants/:tenantId/subscription/extend`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body:**

```json
{
  "extensionType": "SUBSCRIPTION|GRACE",
  "days": 14,
  "reason": "Payment gateway delay"
}
```

`extensionType` is **required**. `SUBSCRIPTION` extends `currentPeriodEnd` by `days`. `GRACE` extends grace window without changing the paid period. Do not combine with legacy `renewsAt` / `graceDays` — those are rejected if sent with `extensionType`.

- **Response (200):**

```json
{
  "success": true,
  "data": {
    "status": "ACTIVE|GRACE",
    "currentPeriodEnd": "2026-10-15",
    "graceEndsAt": "ISO|null",
    "extendedDays": 14
  }
}
```

#### `POST /api/v1/platform/tenants/:tenantId/subscription/cancel`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body:** `{ "reason": "string?" }`
- **Response (200):**

```json
{
  "success": true,
  "data": {
    "status": "CANCELLED",
    "cancelledAt": "ISO",
    "currentPeriodEnd": "2026-10-01"
  }
}
```

#### `GET /api/v1/platform/tenants/:tenantId/invoices`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** no
- **Response (200):**

```json
{
  "success": true,
  "data": [
    {
      "id": "inv_...",
      "invoiceNumber": "PLT/2026/0294",
      "subtotal": { "amountPaise": 524000, "amountDisplay": "₹5,240" },
      "tax": { "amountPaise": 94320, "amountDisplay": "₹943" },
      "total": { "amountPaise": 618320, "amountDisplay": "₹6,183" },
      "status": "UNPAID|PAID|VOID",
      "dueDate": "2026-09-07",
      "pdfUrl": "https://...",
      "paidAt": "ISO|null"
    }
  ]
}
```

#### `POST /api/v1/platform/tenants/:tenantId/invoices`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body:**

```json
{
  "periodStart": "2026-09-01",
  "periodEnd": "2026-10-01",
  "lineItems": [
    { "description": "Growth plan — Sep 2026", "amountPaise": 500000 },
    { "description": "WhatsApp overage", "amountPaise": 24000 }
  ],
  "taxPercent": 18,
  "dueDate": "2026-09-07",
  "notes": null
}
```

Legacy single-field: `{ "amountPaise": 500000, "dueDate": "...", "description": "..." }`

- **Response (201):** invoice DTO (see list item shape)

#### `POST /api/v1/platform/invoices/:invoiceId/mark-paid`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Request body:** `{ "paidAt": "ISO?", "reference": "string?" }`
- **Response (200):** invoice DTO with `status: "PAID"`

#### `GET /api/v1/platform/audit-logs`

- **Auth:** Bearer `PLATFORM_USER`
- **Query:** `tenantId` · `actorId` · `action` · `entityType` · `entityId` · `from` · `to` · `limit` · `cursor`
- **Response (200):**

```json
{
  "success": true,
  "data": [
    {
      "id": "aud_...",
      "at": "ISO",
      "actor": { "id": "pusr_...", "type": "PLATFORM_USER" },
      "tenant": { "id": "tnt_..." },
      "action": "TENANT_SUBSCRIPTION_CHANGED",
      "entityType": "SUBSCRIPTION",
      "entityId": "tnt_...",
      "changes": [],
      "ip": "103.21.x.x",
      "traceId": "uuid"
    }
  ],
  "meta": { "nextCursor": "...", "hasMore": true, "limit": 20 }
}
```

#### `GET /api/v1/platform/webhook-failures`

- **Auth:** Bearer `PLATFORM_USER`
- **Query:** `cursor` · `limit` · `provider?`
- **Response (200):** `data` = array of **WebhookFailureRow**; `meta.total`, `meta.hasMore`, `nextCursor`, `limit`

#### `POST /api/v1/platform/webhook-failures/:id/retry`

- **Auth:** Bearer `PLATFORM_USER`
- **Idempotent:** yes
- **Response (202):** `{ "id": "whk_...", "queued": true }`

#### `GET /api/v1/platform/error-logs`

- **Auth:** Bearer `PLATFORM_USER`
- **Query:** `tenantId?` · `traceId?` · `limit?` (max 500)
- **Response (200):** `data` = array of error log entries (`id`, `code`, `message`, `statusCode`, `traceId`, `occurredAt`, `tenantId`); `meta.total`, `meta.limit`

---

## Intentionally absent

- `POST /platform/tenants/:tenantId/block` — not registered (see `docs/LOCKED_BUSINESS_DECISIONS.md`).

## Status enum notes

- **Tenant:** `PENDING_SETUP` · `ACTIVE` · `SUSPENDED` · `CANCELLED`
- **Tenant subscription:** `TRIAL` · `ACTIVE` · `PAST_DUE` · `GRACE` · `SUSPENDED` · `CANCELLED`
- **Platform invoice API status:** `UNPAID` (issued) · `PAID` · `VOID` (maps from internal `ISSUED` · `PAID` · `VOID`)
