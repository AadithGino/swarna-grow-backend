# Super Admin Panel API Contract

**Audience:** Platform / super-admin console (`PLATFORM_USER`)

**Base:** `http://localhost:4000` · **Prefix:** `/api/v1` (except `/health*`)

> Money = integer **paise**. Weight = integer **mg**.

## Scope
- All `/platform/*` routes
- Platform auth: `/platform/auth/login|refresh|logout`
- Public jeweller signup: `/public/signup/*`, `/public/signup/plans`, availability
- Health checks
- Webhook failure ops already under platform

**Route count in this panel:** 51

See also: [Full contract](./API_CONTRACT.md) · [Admin](./API_CONTRACT_ADMIN.md) · [Super Admin](./API_CONTRACT_SUPER_ADMIN.md) · [Customer](./API_CONTRACT_CUSTOMER.md)

## Conventions

**Success**
```json
{
  "success": true,
  "data": {},
  "meta": {
    "nextCursor": "string?",
    "limit": 20
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
    "details": [
      {
        "field": "body.name",
        "message": "..."
      }
    ],
    "traceId": "uuid"
  }
}
```

**Headers:** `Authorization: Bearer <token>`, `X-Idempotency-Key: <uuid>` on mutating routes, `Content-Type: application/json`

**Subjects:** `PLATFORM_USER` → `/platform/*` · `TENANT_USER` → `/admin/*`, `/staff/*` · `CUSTOMER` → `/app/*`

Full nested `planBody` / flexibleRules: `src/validators/common.validators.js`

## Endpoints

### Health

#### `GET /health`
- **Auth:** none
- **Query:** none
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "timestamp": "ISO"
  }
}
```

#### `GET /health/ready`
- **Auth:** none
- **Query:** none
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "database": "ready",
    "queue": "ready"
  }
}
```

### Public

#### `GET /api/v1/public/signup/:signupId/status`
- **Auth:** none (public rate limit)
- **Path params:** `signupId`
- **Query:** none
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "status": "OTP_VERIFIED",
    "expiresAt": "ISO?"
  }
}
```

#### `GET /api/v1/public/signup/check-availability`
- **Auth:** none (public rate limit)
- **Query:** mobile? & tenantCode?
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "available": true
  }
}
```

#### `GET /api/v1/public/signup/plans`
- **Auth:** none (public rate limit)
- **Query:** cursor?, limit?, sort?, q? (+ filters)
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": []
}
```

#### `POST /api/v1/public/auth/set-password`
- **Auth:** none (public rate limit)
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "password": "string>=8",
  "mobile": "+91...?",
  "tenantCode": "ABC?"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "usr_...",
    "passwordSet": true
  }
}
```

#### `POST /api/v1/public/signup/:signupId/payment/initiate`
- **Auth:** none (public rate limit)
- **Path params:** `signupId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "signupId": "sgn_...",
    "status": "PAYMENT_PENDING",
    "paymentUrl": "string"
  }
}
```

#### `POST /api/v1/public/signup/:signupId/select-plan`
- **Auth:** none (public rate limit)
- **Path params:** `signupId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "planTier": "STARTER|GROWTH|PRO|CUSTOM"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "sgn_...",
    "mobile": "+91...",
    "tenantCode": "ABC?",
    "status": "OTP_PENDING|OTP_VERIFIED|PLAN_SELECTED|PAYMENT_PENDING|PROVISIONED|EXPIRED"
  }
}
```

#### `POST /api/v1/public/signup/start`
- **Auth:** none (public rate limit)
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "mobile": "+91...",
  "businessName": "string?",
  "tenantCode": "ABC"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "signupId": "sgn_...",
    "expiresAt": "ISO"
  }
}
```

#### `POST /api/v1/public/signup/verify-otp`
- **Auth:** none (public rate limit)
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "signupId": "sgn_...",
  "otp": "123456"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "signupId": "sgn_...",
    "status": "OTP_VERIFIED"
  }
}
```

### Platform

#### `DELETE /api/v1/platform/tenants/:tenantId/templates/:messageType`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`, `messageType`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "deleted": true
  }
}
```

#### `GET /api/v1/platform/audit-logs`
- **Auth:** Bearer PLATFORM_USER
- **Query:** cursor?, limit?, sort?, q? (+ filters)
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "_id": "aud_...",
      "action": "string",
      "entityType": "string",
      "entityId": "string",
      "occurredAt": "ISO"
    }
  ]
}
```

#### `GET /api/v1/platform/dashboard/charts/:chartKey`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `chartKey`
- **Query:** cursor?, limit?, sort?, q? (+ filters)
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "key": "YYYY-MM",
      "value": 0
    }
  ]
}
```

#### `GET /api/v1/platform/dashboard/summary`
- **Auth:** Bearer PLATFORM_USER
- **Query:** cursor?, limit?, sort?, q? (+ filters)
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "summary": "aggregate counts & paise totals"
  }
}
```

#### `GET /api/v1/platform/error-logs`
- **Auth:** Bearer PLATFORM_USER
- **Query:** tenantId?
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "_id": "err_...",
      "code": "string",
      "message": "string",
      "statusCode": 0,
      "occurredAt": "ISO"
    }
  ]
}
```

#### `GET /api/v1/platform/subscription-plans`
- **Auth:** Bearer PLATFORM_USER
- **Query:** cursor?, limit?, sort?, q? (+ filters)
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "summary": "aggregate counts & paise totals"
  }
}
```

#### `GET /api/v1/platform/subscription-plans/:planId`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `planId`
- **Query:** cursor?, limit?, sort?, q? (+ filters)
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "summary": "aggregate counts & paise totals"
  }
}
```

#### `GET /api/v1/platform/template-definitions`
- **Auth:** Bearer PLATFORM_USER
- **Query:** cursor?, limit?, sort?, q? (+ filters)
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": []
}
```

#### `GET /api/v1/platform/tenants`
- **Auth:** Bearer PLATFORM_USER
- **Query:** cursor?, limit?, sort?, q? (+ filters)
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": []
}
```

#### `GET /api/v1/platform/tenants/:tenantId`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "tnt_...",
    "code": "ABC",
    "name": "string",
    "status": "PENDING_SETUP|ACTIVE|SUSPENDED|CANCELLED",
    "mobile": "+91...",
    "branding": {},
    "settings": {},
    "subscription": {},
    "version": 1,
    "branches": [
      {
        "_id": "brn_...",
        "tenantId": "tnt_...",
        "code": "HQ",
        "name": "string",
        "active": true,
        "version": 1
      }
    ],
    "staff": [
      {
        "_id": "usr_...",
        "type": "PLATFORM_USER|TENANT_USER",
        "tenantId": "tnt_|null",
        "role": "TENANT_OWNER|TENANT_ADMIN|BRANCH_MANAGER|BRANCH_STAFF?",
        "name": "string",
        "mobile": "+91...",
        "status": "ACTIVE|INACTIVE",
        "permissions": [],
        "mustSetPassword": false
      }
    ]
  }
}
```

#### `GET /api/v1/platform/tenants/:tenantId/flags`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "featureKey": true
  }
}
```

#### `GET /api/v1/platform/tenants/:tenantId/invoices`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** cursor?, limit?, sort?, q? (+ filters)
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": []
}
```

#### `GET /api/v1/platform/tenants/:tenantId/templates`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** cursor?, limit?, sort?, q? (+ filters)
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": []
}
```

#### `GET /api/v1/platform/tenants/:tenantId/usage`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "usage": {
      "activeCustomers": 0,
      "branches": 0,
      "staff": 0,
      "schemes": 0
    },
    "limits": {}
  }
}
```

#### `GET /api/v1/platform/webhook-failures`
- **Auth:** Bearer PLATFORM_USER
- **Query:** cursor?, limit?, provider?
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "_id": "whk_...",
      "provider": "PHONEPE|WHATSAPP",
      "providerEventId": "string",
      "status": "FAILED|DEAD_LETTER|..."
    }
  ]
}
```

#### `PATCH /api/v1/platform/subscription-plans/:planId`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `planId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "tier": "STARTER|GROWTH|PRO|CUSTOM",
  "name": "string?",
  "pricePaise": 0,
  "billingCycle": "MONTHLY|ANNUAL",
  "limits": {},
  "features": [],
  "active": true,
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "sub_...",
    "tier": "STARTER|GROWTH|PRO|CUSTOM",
    "pricePaise": 0,
    "billingCycle": "MONTHLY|ANNUAL",
    "active": true
  }
}
```

#### `PATCH /api/v1/platform/tenants/:tenantId`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "name": "string?",
  "email": "string?",
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "tnt_...",
    "code": "ABC",
    "name": "string",
    "status": "PENDING_SETUP|ACTIVE|SUSPENDED|CANCELLED",
    "mobile": "+91...",
    "branding": {},
    "settings": {},
    "subscription": {},
    "version": 1
  }
}
```

#### `PATCH /api/v1/platform/tenants/:tenantId/subscription/limits`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "limits": {
    "activeCustomers": 0,
    "branches": 0,
    "staff": 0,
    "schemePlans": 0,
    "whatsappMessages": 0
  }
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "limits": {
      "activeCustomers": 0,
      "branches": 0,
      "staff": 0,
      "schemePlans": 0,
      "whatsappMessages": 0
    }
  }
}
```

#### `POST /api/v1/platform/auth/login`
- **Auth:** none
- **Query:** none
- **Idempotent:** no
- **Request body:**
```json
{
  "tenantCode": "ABC?",
  "mobile": "+919999999999",
  "password": "string>=8",
  "deviceId": "string>=4",
  "platform": "web|android|ios",
  "appVersion": "string?"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr_...",
      "name": "string",
      "role": "TENANT_OWNER",
      "tenantId": "tnt_?",
      "branchId": "brn_?",
      "permissions": [],
      "mustSetPassword": false
    },
    "accessToken": "jwt",
    "refreshToken": "opaque",
    "expiresIn": "30m",
    "tokenType": "Bearer"
  }
}
```

#### `POST /api/v1/platform/auth/logout`
- **Auth:** Bearer PLATFORM_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "refreshToken": "string?"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "loggedOut": true
  }
}
```

#### `POST /api/v1/platform/auth/refresh`
- **Auth:** none
- **Query:** none
- **Idempotent:** no
- **Request body:**
```json
{
  "refreshToken": "string"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "accessToken": "jwt",
    "refreshToken": "opaque",
    "expiresIn": "30m",
    "tokenType": "Bearer"
  }
}
```

#### `POST /api/v1/platform/invoices/:invoiceId/mark-paid`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `invoiceId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "paidAt": "ISO?",
  "reference": "string?"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "inv_...",
    "amountPaise": 0,
    "status": "ISSUED|PAID|VOID",
    "dueDate": "YYYY-MM-DD?"
  }
}
```

#### `POST /api/v1/platform/subscription-plans`
- **Auth:** Bearer PLATFORM_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "tier": "STARTER|GROWTH|PRO|CUSTOM",
  "name": "string?",
  "pricePaise": 0,
  "billingCycle": "MONTHLY|ANNUAL",
  "limits": {},
  "features": [],
  "active": true,
  "expectedVersion": 1
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "sub_...",
    "tier": "STARTER|GROWTH|PRO|CUSTOM",
    "pricePaise": 0,
    "billingCycle": "MONTHLY|ANNUAL",
    "active": true
  }
}
```

#### `POST /api/v1/platform/subscription-plans/:planId/deprecate`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `planId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "sub_...",
    "tier": "STARTER|GROWTH|PRO|CUSTOM",
    "pricePaise": 0,
    "billingCycle": "MONTHLY|ANNUAL",
    "active": true
  }
}
```

#### `POST /api/v1/platform/tenants`
- **Auth:** Bearer PLATFORM_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "code": "ABC",
  "name": "string",
  "mobile": "+91...",
  "email": "string?",
  "ownerName": "string",
  "temporaryPassword": "string",
  "headOfficeName": "string?",
  "subscription": {}
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "tenant": {
      "_id": "tnt_...",
      "code": "ABC",
      "name": "string",
      "status": "PENDING_SETUP|ACTIVE|SUSPENDED|CANCELLED",
      "mobile": "+91...",
      "branding": {},
      "settings": {},
      "subscription": {},
      "version": 1
    },
    "branch": {
      "_id": "brn_...",
      "tenantId": "tnt_...",
      "code": "HQ",
      "name": "string",
      "active": true,
      "version": 1
    },
    "owner": {
      "id": "usr_...",
      "mobile": "+91...",
      "mustSetPassword": true
    }
  }
}
```

#### `POST /api/v1/platform/tenants/:tenantId/go-live`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "ok": true
  }
}
```

#### `POST /api/v1/platform/tenants/:tenantId/integrations/payment-gateway/verify`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "verified": true,
    "verifiedAt": "ISO"
  }
}
```

#### `POST /api/v1/platform/tenants/:tenantId/integrations/whatsapp/verify`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "verified": true,
    "verifiedAt": "ISO"
  }
}
```

#### `POST /api/v1/platform/tenants/:tenantId/invoices`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "amountPaise": 1,
  "dueDate": "YYYY-MM-DD?",
  "reference": "string?"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "inv_...",
    "amountPaise": 0,
    "status": "ISSUED|PAID|VOID",
    "dueDate": "YYYY-MM-DD?"
  }
}
```

#### `POST /api/v1/platform/tenants/:tenantId/owner-credentials`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "temporaryPassword": "string"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "ownerId": "usr_...",
    "mustSetPassword": true
  }
}
```

#### `POST /api/v1/platform/tenants/:tenantId/reactivate`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "ok": true
  }
}
```

#### `POST /api/v1/platform/tenants/:tenantId/subscription/cancel`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "status": "CANCELLED"
  }
}
```

#### `POST /api/v1/platform/tenants/:tenantId/subscription/change-plan`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "planId": "sub_..."
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "tier": "STARTER",
    "status": "ACTIVE"
  }
}
```

#### `POST /api/v1/platform/tenants/:tenantId/subscription/extend`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "renewsAt": "ISO"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "renewsAt": "ISO"
  }
}
```

#### `POST /api/v1/platform/tenants/:tenantId/suspend`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "ok": true
  }
}
```

#### `POST /api/v1/platform/tenants/:tenantId/templates/:messageType/test`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`, `messageType`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "mobile": "+91..."
}
```
- **Response (202):**
```json
{
  "success": true,
  "data": {
    "queued": true,
    "to": "+91..."
  }
}
```

#### `POST /api/v1/platform/webhook-failures/:id/retry`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `id`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
null
```
- **Response (202):**
```json
{
  "success": true,
  "data": {
    "queued": true
  }
}
```

#### `PUT /api/v1/platform/tenants/:tenantId/flags`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "flags": {
    "featureKey": true
  }
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "flags": {
      "featureKey": true
    },
    "version": 1
  }
}
```

#### `PUT /api/v1/platform/tenants/:tenantId/integrations/payment-gateway`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "merchantId": "string?",
  "saltKey": "string?",
  "saltIndex": "string?"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "tenantId": "tnt_...",
    "integration": "phonepe",
    "configured": true,
    "version": 1
  }
}
```

#### `PUT /api/v1/platform/tenants/:tenantId/integrations/whatsapp`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "phoneNumberId": "string?",
  "businessAccountId": "string?",
  "accessToken": "string?",
  "appSecret": "string?",
  "verifyToken": "string?"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "tenantId": "tnt_...",
    "integration": "whatsapp",
    "configured": true,
    "version": 1
  }
}
```

#### `PUT /api/v1/platform/tenants/:tenantId/templates/:messageType`
- **Auth:** Bearer PLATFORM_USER
- **Path params:** `tenantId`, `messageType`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "language": "en",
  "providerTemplateName": "string?",
  "body": "string?",
  "variables": [],
  "active": true
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "tpl_...",
    "messageType": "string",
    "body": "string?",
    "variables": [],
    "active": true
  }
}
```

