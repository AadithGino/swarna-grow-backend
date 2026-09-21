# SwarnaGrow API Contract (v1.2)

**Panel-wise split:** [Index](./API_CONTRACT_PANELS.md) · [Super Admin](./API_CONTRACT_SUPER_ADMIN.md) · [Admin](./API_CONTRACT_ADMIN.md) · [Collection agent app](./API_CONTRACT_STAFF.md) · [Customer](./API_CONTRACT_CUSTOMER.md)

Base: `http://localhost:4000` · Prefix: `/api/v1` (except `/health*`)

> Money in integer **paise**. Weight in integer **mg**.

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

#### `GET /api/v1/public/app-config`
- **Auth:** none (public rate limit)
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
    "android": {
      "minimumVersion": "1.0.0",
      "forceUpdate": false
    },
    "ios": {
      "minimumVersion": "1.0.0",
      "forceUpdate": false
    },
    "maintenance": null
  }
}
```

#### `GET /api/v1/public/pay/:linkToken`
- **Auth:** none (public rate limit)
- **Path params:** `linkToken`
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
    "_id": "plk_...",
    "schemeId": "sch_?",
    "amountPaise": 1,
    "status": "CREATED|SENT|OPENED|PAID|EXPIRED|CANCELLED",
    "expiresAt": "ISO",
    "paymentId": "pay_?"
  }
}
```

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

#### `GET /api/v1/public/tenants/:tenantId/branches`
- **Auth:** none (public rate limit)
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

#### `GET /api/v1/public/tenants/resolve`
- **Auth:** none (public rate limit)
- **Query:** tenantCode= | mobile=
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
    "branding": {},
    "status": "ACTIVE"
  }
}
```

#### `POST /api/v1/public/auth/otp/request`
- **Auth:** none (public rate limit)
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "tenantCode": "ABC",
  "mobile": "+91...",
  "purpose": "LOGIN|SIGNUP|PASSWORD_RESET",
  "deviceId": "string>=4"
}
```
- **Response (202):**
```json
{
  "success": true,
  "data": {
    "sent": true,
    "expiresInSeconds": 300
  }
}
```

#### `POST /api/v1/public/auth/otp/verify`
- **Auth:** none (public rate limit)
- **Query:** none
- **Idempotent:** no
- **Request body:**
```json
{
  "tenantCode": "ABC",
  "mobile": "+91...",
  "purpose": "LOGIN|SIGNUP|PASSWORD_RESET",
  "deviceId": "string>=4",
  "otp": "123456"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "customer": {
      "id": "cus_...",
      "name": "string",
      "profileComplete": false
    },
    "accessToken": "jwt",
    "refreshToken": "opaque",
    "expiresIn": "30m",
    "tokenType": "Bearer"
  }
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

#### `POST /api/v1/public/pay/:linkToken/initiate`
- **Auth:** none (public rate limit)
- **Path params:** `linkToken`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "redirectUrl": "url?",
  "mobile": "+91...?"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "redirectUrl": "url?",
    "providerOrderId": "string?",
    "paymentId": "pay_?"
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

### Auth

#### `DELETE /api/v1/auth/devices/:deviceId`
- **Auth:** Bearer (authenticated)
- **Path params:** `deviceId`
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
    "revoked": true
  }
}
```

#### `GET /api/v1/auth/devices`
- **Auth:** Bearer (authenticated)
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
  "data": [
    {
      "deviceId": "string",
      "platform": "web",
      "lastUsedAt": "ISO",
      "expiresAt": "ISO"
    }
  ]
}
```

#### `GET /api/v1/auth/me`
- **Auth:** Bearer (authenticated)
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
}
```

#### `POST /api/v1/auth/change-password`
- **Auth:** Bearer (authenticated)
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "currentPassword": "string",
  "newPassword": "string>=8"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "passwordChanged": true,
    "sessionsRevoked": true
  }
}
```

#### `POST /api/v1/auth/forgot-password`
- **Auth:** none
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "tenantCode": "ABC",
  "mobile": "+91...",
  "purpose": "LOGIN|SIGNUP|PASSWORD_RESET",
  "deviceId": "string>=4"
}
```
- **Response (202):**
```json
{
  "success": true,
  "data": {
    "sent": true,
    "expiresInSeconds": 300
  }
}
```

#### `POST /api/v1/auth/login`
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

#### `POST /api/v1/auth/logout`
- **Auth:** Bearer (authenticated)
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

#### `POST /api/v1/auth/refresh`
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
  "provider": "PHONEPE",
  "clientId": "string",
  "clientSecret": "string",
  "clientVersion": 1,
  "webhookUsername": "string",
  "webhookPassword": "string",
  "environment": "SANDBOX|PRODUCTION"
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

### Admin — Customers

#### `DELETE /api/v1/admin/customers/:customerId/nominee`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
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

#### `GET /api/v1/admin/customers`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/customers/:customerId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
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
    "_id": "cus_...",
    "tenantId": "tnt_...",
    "branchId": "brn_...",
    "customerNumber": "C0001",
    "name": "string",
    "mobile": "+91...",
    "email": "string?",
    "status": "ACTIVE|BLOCKED|INACTIVE",
    "kyc": {},
    "nominee": {},
    "version": 1,
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}
```

#### `GET /api/v1/admin/customers/:customerId/audit-events`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
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

#### `GET /api/v1/admin/customers/:customerId/messages`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
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

#### `GET /api/v1/admin/customers/:customerId/nominee`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
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
    "name": "string",
    "relationship": "SPOUSE"
  }
}
```

#### `GET /api/v1/admin/customers/:customerId/payments`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
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

#### `GET /api/v1/admin/customers/:customerId/schemes`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
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

#### `GET /api/v1/admin/customers/:customerId/statement`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
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

#### `GET /api/v1/admin/customers/analytics`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/customers/check-mobile`
- **Auth:** Bearer TENANT_USER
- **Query:** mobile=
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
    "exists": false
  }
}
```

#### `PATCH /api/v1/admin/customers/:customerId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "branchId": "brn_?",
  "name": "string",
  "mobile": "+91...",
  "email": "email?",
  "dateOfBirth": "string?",
  "address": "string?",
  "passbookNumber": "string?",
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "cus_...",
    "tenantId": "tnt_...",
    "branchId": "brn_...",
    "customerNumber": "C0001",
    "name": "string",
    "mobile": "+91...",
    "email": "string?",
    "status": "ACTIVE|BLOCKED|INACTIVE",
    "kyc": {},
    "nominee": {},
    "version": 1,
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}
```

#### `PATCH /api/v1/admin/customers/:customerId/whatsapp-opt`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "optedOut": true
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "cus_...",
    "tenantId": "tnt_...",
    "branchId": "brn_...",
    "customerNumber": "C0001",
    "name": "string",
    "mobile": "+91...",
    "email": "string?",
    "status": "ACTIVE|BLOCKED|INACTIVE",
    "kyc": {},
    "nominee": {},
    "version": 1,
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}
```

#### `POST /api/v1/admin/customers`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "branchId": "brn_?",
  "name": "string",
  "mobile": "+91...",
  "email": "email?",
  "dateOfBirth": "string?",
  "address": "string?",
  "passbookNumber": "string?"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "cus_...",
    "tenantId": "tnt_...",
    "branchId": "brn_...",
    "customerNumber": "C0001",
    "name": "string",
    "mobile": "+91...",
    "email": "string?",
    "status": "ACTIVE|BLOCKED|INACTIVE",
    "kyc": {},
    "nominee": {},
    "version": 1,
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}
```

#### `POST /api/v1/admin/customers/:customerId/block`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
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

#### `POST /api/v1/admin/customers/:customerId/kyc/verify`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "approved": true,
  "rejectionReason": "string?",
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "cus_...",
    "tenantId": "tnt_...",
    "branchId": "brn_...",
    "customerNumber": "C0001",
    "name": "string",
    "mobile": "+91...",
    "email": "string?",
    "status": "ACTIVE|BLOCKED|INACTIVE",
    "kyc": {},
    "nominee": {},
    "version": 1,
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}
```

#### `POST /api/v1/admin/customers/:customerId/notes`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "note": "string"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "saved": true
  }
}
```

#### `POST /api/v1/admin/customers/:customerId/unblock`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
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

#### `PUT /api/v1/admin/customers/:customerId/kyc`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "type": "AADHAAR|PAN",
  "number": "string?",
  "frontUploadId": "upl_?",
  "backUploadId": "upl_?",
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "cus_...",
    "tenantId": "tnt_...",
    "branchId": "brn_...",
    "customerNumber": "C0001",
    "name": "string",
    "mobile": "+91...",
    "email": "string?",
    "status": "ACTIVE|BLOCKED|INACTIVE",
    "kyc": {},
    "nominee": {},
    "version": 1,
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}
```

#### `PUT /api/v1/admin/customers/:customerId/nominee`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "name": "string",
  "relationship": "SPOUSE|PARENT|CHILD|SIBLING|RELATIVE|FRIEND|OTHER",
  "mobile": "+91...?",
  "dateOfBirth": "string?",
  "address": "string?",
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "cus_...",
    "tenantId": "tnt_...",
    "branchId": "brn_...",
    "customerNumber": "C0001",
    "name": "string",
    "mobile": "+91...",
    "email": "string?",
    "status": "ACTIVE|BLOCKED|INACTIVE",
    "kyc": {},
    "nominee": {},
    "version": 1,
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}
```

### Admin — Config & settings

#### `GET /api/v1/admin/alerts`
- **Auth:** Bearer TENANT_USER
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
      "_id": "alt_...",
      "type": "MISSING_GOLD_RATE|...",
      "severity": "WARNING",
      "status": "OPEN|DISMISSED|RESOLVED",
      "title": "string"
    }
  ]
}
```

#### `GET /api/v1/admin/branches`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/branches/:branchId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `branchId`
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
    "_id": "brn_...",
    "tenantId": "tnt_...",
    "code": "HQ",
    "name": "string",
    "active": true,
    "version": 1
  }
}
```

#### `GET /api/v1/admin/gold-rate/current`
- **Auth:** Bearer TENANT_USER
- **Query:** branchId?
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
    "_id": "grt_...",
    "ratePerGramPaise": 1,
    "effectiveDate": "YYYY-MM-DD",
    "purity": "22K"
  }
}
```

#### `GET /api/v1/admin/gold-rate/history`
- **Auth:** Bearer TENANT_USER
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
      "_id": "grt_...",
      "ratePerGramPaise": 1,
      "effectiveDate": "YYYY-MM-DD",
      "purity": "22K"
    }
  ]
}
```

#### `GET /api/v1/admin/settings/branding`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/settings/operations`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/settings/profile`
- **Auth:** Bearer TENANT_USER
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
}
```

#### `GET /api/v1/admin/staff`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/staff/:staffId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `staffId`
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
}
```

#### `GET /api/v1/admin/subscription`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/subscription/available-plans`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/subscription/invoices`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/subscription/usage`
- **Auth:** Bearer TENANT_USER
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

#### `PATCH /api/v1/admin/branches/:branchId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `branchId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "code": "string",
  "name": "string",
  "mobile": "string?",
  "email": "string?",
  "address": "string?",
  "isHeadOffice": false,
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "brn_...",
    "tenantId": "tnt_...",
    "code": "HQ",
    "name": "string",
    "active": true,
    "version": 1
  }
}
```

#### `PATCH /api/v1/admin/settings/branding`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "logoUploadId": "upl_?",
  "primaryColor": "string?",
  "accentColor": "string?",
  "displayName": "string?",
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

#### `PATCH /api/v1/admin/settings/operations`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "timezone": "Asia/Kolkata",
  "currency": "INR",
  "requireKycForEnrolment": false,
  "requireKycForRedemption": true,
  "oneActiveSchemePerCustomer": false,
  "customerAppMaintenance": false,
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

#### `PATCH /api/v1/admin/settings/profile`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "name": "string?",
  "email": "string?",
  "gstin": "string?",
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

#### `PATCH /api/v1/admin/staff/:staffId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `staffId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "name": "string",
  "mobile": "+91...",
  "email": "string?",
  "role": "BRANCH_STAFF",
  "branchId": "brn_?",
  "temporaryPassword": "string?",
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
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
}
```

#### `POST /api/v1/admin/alerts/:alertId/dismiss`
- **Auth:** Bearer TENANT_USER
- **Path params:** `alertId`
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

#### `POST /api/v1/admin/branches`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "code": "string",
  "name": "string",
  "mobile": "string?",
  "email": "string?",
  "address": "string?",
  "isHeadOffice": false
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "brn_...",
    "tenantId": "tnt_...",
    "code": "HQ",
    "name": "string",
    "active": true,
    "version": 1
  }
}
```

#### `POST /api/v1/admin/branches/:branchId/activate`
- **Auth:** Bearer TENANT_USER
- **Path params:** `branchId`
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

#### `POST /api/v1/admin/branches/:branchId/deactivate`
- **Auth:** Bearer TENANT_USER
- **Path params:** `branchId`
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

#### `POST /api/v1/admin/gold-rate`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "branchId": null,
  "ratePerGramPaise": 1,
  "effectiveDate": "YYYY-MM-DD",
  "purity": "22K",
  "source": "string?"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "grt_...",
    "ratePerGramPaise": 1,
    "effectiveDate": "YYYY-MM-DD",
    "purity": "22K"
  }
}
```

#### `POST /api/v1/admin/staff`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "name": "string",
  "mobile": "+91...",
  "email": "string?",
  "role": "BRANCH_STAFF",
  "branchId": "brn_?",
  "temporaryPassword": "string?"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "user": {
      "_id": "usr_...",
      "type": "PLATFORM_USER|TENANT_USER",
      "tenantId": "tnt_|null",
      "role": "TENANT_OWNER|TENANT_ADMIN|BRANCH_MANAGER|BRANCH_STAFF?",
      "name": "string",
      "mobile": "+91...",
      "status": "ACTIVE|INACTIVE",
      "permissions": [],
      "mustSetPassword": false
    },
    "temporaryPassword": "string?"
  }
}
```

#### `POST /api/v1/admin/staff/:staffId/activate`
- **Auth:** Bearer TENANT_USER
- **Path params:** `staffId`
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

#### `POST /api/v1/admin/staff/:staffId/deactivate`
- **Auth:** Bearer TENANT_USER
- **Path params:** `staffId`
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

#### `POST /api/v1/admin/staff/:staffId/reset-password`
- **Auth:** Bearer TENANT_USER
- **Path params:** `staffId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "temporaryPassword": "string?"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "usr_...",
    "mustSetPassword": true
  }
}
```

#### `POST /api/v1/admin/staff/:staffId/transfer-branch`
- **Auth:** Bearer TENANT_USER
- **Path params:** `staffId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "branchId": "brn_..."
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
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
}
```

#### `POST /api/v1/admin/subscription/upgrade-request`
- **Auth:** Bearer TENANT_USER
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

### Admin — Schemes & payments

#### `GET /api/v1/admin/payment-links`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/payments`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/payments/:paymentId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `paymentId`
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
    "_id": "pay_...",
    "schemeId": "sch_...",
    "customerId": "cus_...",
    "receiptNumber": "string",
    "amountPaise": 1,
    "mode": "CASH|CARD|UPI|BANK_TRANSFER|CHEQUE|ONLINE_GATEWAY",
    "status": "PENDING|SUCCESS|FAILED|REVERSED|...",
    "source": "PORTAL|STAFF_APP|CUSTOMER_APP|WEBHOOK|SYSTEM",
    "paidAt": "ISO"
  }
}
```

#### `GET /api/v1/admin/payments/:paymentId/audit-events`
- **Auth:** Bearer TENANT_USER
- **Path params:** `paymentId`
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

#### `GET /api/v1/admin/payments/:paymentId/passbook-image`
- **Auth:** Bearer TENANT_USER
- **Path params:** `paymentId`
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
    "contentType": "application/pdf",
    "url": "string?"
  }
}
```

#### `GET /api/v1/admin/payments/:paymentId/receipt`
- **Auth:** Bearer TENANT_USER
- **Path params:** `paymentId`
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
    "contentType": "application/pdf",
    "url": "string?"
  }
}
```

#### `GET /api/v1/admin/payments/late-success`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/payments/pending`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/redemptions`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/redemptions/:redemptionId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `redemptionId`
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
    "_id": "red_...",
    "schemeId": "sch_...",
    "closureType": "MATURITY_REDEMPTION|PREMATURE_CLOSURE",
    "mode": "CASH|GOLD_HANDOVER|PURCHASE_ADJUSTMENT",
    "status": "REQUESTED|PENDING_APPROVAL|APPROVED|COMPLETED|REJECTED",
    "settlementPaise": 0
  }
}
```

#### `GET /api/v1/admin/redemptions/:redemptionId/receipt`
- **Auth:** Bearer TENANT_USER
- **Path params:** `redemptionId`
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
    "contentType": "application/pdf",
    "url": "string?"
  }
}
```

#### `GET /api/v1/admin/scheme-plans`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/scheme-plans/:planId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `planId`
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
    "_id": "spl_...",
    "tenantId": "tnt_...",
    "name": "string",
    "code": "ABC",
    "valueBasis": "CASH|GOLD_WEIGHT",
    "paymentPattern": "FIXED|FLEXIBLE",
    "durationMonths": 11,
    "installmentCount": 11,
    "amountRules": {},
    "scheduleRules": {},
    "paymentRules": {},
    "flexibleRules": null,
    "goldRules": null,
    "redemptionRules": {},
    "availability": {},
    "status": "DRAFT|ACTIVE|INACTIVE",
    "version": 1
  }
}
```

#### `GET /api/v1/admin/scheme-plans/:planId/stats`
- **Auth:** Bearer TENANT_USER
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
  "data": []
}
```

#### `GET /api/v1/admin/schemes`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/schemes/:schemeId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `schemeId`
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
    "_id": "sch_...",
    "tenantId": "tnt_...",
    "customerId": "cus_...",
    "planId": "spl_...",
    "enrollmentNumber": "string",
    "status": "ACTIVE|LOCKED|DEFAULTED|MATURED|REDEEMED|CLOSED_PREMATURE",
    "startDate": "YYYY-MM-DD",
    "maturityDate": "YYYY-MM-DD",
    "installmentAmountPaise": 0,
    "installments": [],
    "cycles": [],
    "positionVersion": 1,
    "version": 1
  }
}
```

#### `GET /api/v1/admin/schemes/:schemeId/audit-events`
- **Auth:** Bearer TENANT_USER
- **Path params:** `schemeId`
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

#### `GET /api/v1/admin/schemes/:schemeId/ledger`
- **Auth:** Bearer TENANT_USER
- **Path params:** `schemeId`
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
      "_id": "led_...",
      "schemeId": "sch_...",
      "type": "INSTALLMENT_PAYMENT|...",
      "sequence": 1,
      "amountPaise": 0,
      "effectiveAt": "ISO"
    }
  ]
}
```

#### `GET /api/v1/admin/schemes/:schemeId/maturity-projection`
- **Auth:** Bearer TENANT_USER
- **Path params:** `schemeId`
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
    "principalPaise": 0,
    "benefitPaise": 0,
    "penaltyPaise": 0,
    "settlementPaise": 0
  }
}
```

#### `GET /api/v1/admin/schemes/:schemeId/passbook`
- **Auth:** Bearer TENANT_USER
- **Path params:** `schemeId`
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
    "scheme": {
      "_id": "sch_...",
      "tenantId": "tnt_...",
      "customerId": "cus_...",
      "planId": "spl_...",
      "enrollmentNumber": "string",
      "status": "ACTIVE|LOCKED|DEFAULTED|MATURED|REDEEMED|CLOSED_PREMATURE",
      "startDate": "YYYY-MM-DD",
      "maturityDate": "YYYY-MM-DD",
      "installmentAmountPaise": 0,
      "installments": [],
      "cycles": [],
      "positionVersion": 1,
      "version": 1
    },
    "ledger": [
      {
        "_id": "led_...",
        "schemeId": "sch_...",
        "type": "INSTALLMENT_PAYMENT|...",
        "sequence": 1,
        "amountPaise": 0,
        "effectiveAt": "ISO"
      }
    ]
  }
}
```

#### `GET /api/v1/admin/schemes/:schemeId/payable-range`
- **Auth:** Bearer TENANT_USER
- **Path params:** `schemeId`
- **Query:** `targetCycle` (flexible capped phase only)
- **Idempotent:** no
- **Request body:**
```json
null
```
- **Fixed schemes (`paymentPattern: FIXED`):** amounts come from the central fixed-payment policy. `maxAdvanceInstallments` is the count of **future** instalments allowed **in addition to** the current due instalment (window size = `1 + maxAdvanceInstallments` when advance is enabled).
- **Response (200) — fixed example:**
```json
{
  "success": true,
  "data": {
    "model": "FIXED",
    "payable": true,
    "currentInstallmentNumber": 2,
    "reservedPaise": 100000,
    "minPayablePaise": 100000,
    "maxPayablePaise": 100000,
    "allowedAmountsPaise": [100000, 200000],
    "advancePaymentAllowed": true,
    "maxAdvanceInstallments": 1,
    "partialPaymentAllowed": false,
    "expectedPositionVersion": 3,
    "expectedVersion": 3
  }
}
```
- **Manual fixed payment while an online reservation is active:** `422 PAYMENT_CONFIRMATION_PENDING` — staff must **cancel** the pending payment link first.
- **Stale successful gateway payment** (cancelled/expired reservation, shifted instalments): payment status `UNALLOCATED_PENDING_REVIEW` with review ledger — not allocated to instalments.

#### `GET /api/v1/admin/schemes/:schemeId/payment-intents`
- **Auth:** Bearer TENANT_USER
- **Path params:** `schemeId`
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

#### `GET /api/v1/admin/schemes/:schemeId/settlement-preview`
- **Auth:** Bearer TENANT_USER
- **Path params:** `schemeId`
- **Query:** `closureType=MATURITY_REDEMPTION|PREMATURE_CLOSURE`; for gold-weight schemes **`mode`** (`CASH`, `GOLD_HANDOVER`, `PURCHASE_ADJUSTMENT`) is required.
- **Idempotent:** no
- **Classification:** `systemPolicyClosure`, `closureReason`, benefit/penalty zeroing, and `settlementRequired` are derived from **persisted Scheme state** only (never from request body).
- **System-policy closure:** when `status=CLOSED_PREMATURE`, `settlementRequired=true`, and `closureReason` is `ZERO_FLEXIBLE_PHASE_TOTAL` or `BELOW_MINIMUM_FLEXIBLE_PHASE_TOTAL`, settlement is **principal-only** (net allocated ledger). Customers receive `SETTLEMENT_STAFF_REQUIRED`; staff use `PREMATURE_CLOSURE` initiation/completion.
- **Premature benefit treatment:** `FORFEIT` or `FULL` only (`PRORATE` rejected on plan create/update).
- **Redemption modes:** `CASH`, `GOLD_HANDOVER`, `PURCHASE_ADJUSTMENT` only (`TRANSFER_TO_SCHEME` rejected). `PURCHASE_ADJUSTMENT` requires `billNumber`; cash payout is zero.
- **Gold:** operational valuation uses **exact-day 22K** rate (`GOLD_RATE_NOT_SET` when missing). Cash-plan gold handover weight is computed from settlement paise at completion-day rate.
- **Request body:**
```json
null
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "eligible": true,
    "systemPolicyClosure": false,
    "closureReason": "",
    "principalPaise": 0,
    "benefitPaise": 0,
    "penaltyPaise": 0,
    "settlementPaise": 0,
    "mode": "CASH",
    "valuationRatePerGramPaise": 0,
    "valuationRateEffectiveDate": "YYYY-MM-DD",
    "blockers": []
  }
}
```

#### `PATCH /api/v1/admin/scheme-plans/:planId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `planId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "name": "string",
  "code": "ABC",
  "valueBasis": "CASH|GOLD_WEIGHT",
  "paymentPattern": "FIXED|FLEXIBLE",
  "durationMonths": 11,
  "installmentCount": 11,
  "amountRules": {},
  "scheduleRules": {},
  "paymentRules": {},
  "flexibleRules": null,
  "goldRules": null,
  "redemptionRules": {},
  "availability": {},
  "status": "DRAFT",
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "spl_...",
    "tenantId": "tnt_...",
    "name": "string",
    "code": "ABC",
    "valueBasis": "CASH|GOLD_WEIGHT",
    "paymentPattern": "FIXED|FLEXIBLE",
    "durationMonths": 11,
    "installmentCount": 11,
    "amountRules": {},
    "scheduleRules": {},
    "paymentRules": {},
    "flexibleRules": null,
    "goldRules": null,
    "redemptionRules": {},
    "availability": {},
    "status": "DRAFT|ACTIVE|INACTIVE",
    "version": 1
  }
}
```

#### `POST /api/v1/admin/payment-links`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Expiry:** `expiresInMinutes` defaults to **30** and cannot exceed **30** (fixed and flexible links).
- **Fixed schemes:** creates a **PaymentIntent reservation** (`fixedFromInstallment` / `fixedThroughInstallment`) that holds instalment capacity until paid, cancelled, failed, or expired.
- **Request body:**
```json
{
  "schemeId": "sch_...",
  "amountPaise": 1,
  "targetCycle": "YYYY-MM?",
  "expectedPositionVersion": 1,
  "expiresInMinutes": 30
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "plk_...",
    "schemeId": "sch_?",
    "amountPaise": 1,
    "status": "CREATED|SENT|OPENED|PAID|EXPIRED|CANCELLED",
    "expiresAt": "ISO",
    "paymentId": "pay_?"
  }
}
```

#### `POST /api/v1/admin/payment-links/:linkId/cancel`
- **Auth:** Bearer TENANT_USER
- **Path params:** `linkId`
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

#### `POST /api/v1/admin/payment-links/:linkId/resend`
- **Auth:** Bearer TENANT_USER
- **Path params:** `linkId`
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

#### `POST /api/v1/admin/payments`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "schemeId": "sch_...",
  "amountPaise": 1,
  "mode": "CASH|CARD|UPI|BANK_TRANSFER|CHEQUE",
  "targetCycle": "YYYY-MM?",
  "expectedVersion": 1,
  "positionVersion": 1,
  "reference": "string?",
  "remarks": "string?"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "pay_...",
    "schemeId": "sch_...",
    "customerId": "cus_...",
    "receiptNumber": "string",
    "amountPaise": 1,
    "mode": "CASH|CARD|UPI|BANK_TRANSFER|CHEQUE|ONLINE_GATEWAY",
    "status": "PENDING|SUCCESS|FAILED|REVERSED|...",
    "source": "PORTAL|STAFF_APP|CUSTOMER_APP|WEBHOOK|SYSTEM",
    "paidAt": "ISO"
  }
}
```

#### `POST /api/v1/admin/payments/:paymentId/reconcile`
- **Auth:** Bearer TENANT_USER
- **Path params:** `paymentId`
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

#### `POST /api/v1/admin/payments/:paymentId/reverse`
- **Auth:** Bearer TENANT_USER
- **Path params:** `paymentId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "reason": "string?",
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "pay_...",
    "schemeId": "sch_...",
    "customerId": "cus_...",
    "receiptNumber": "string",
    "amountPaise": 1,
    "mode": "CASH|CARD|UPI|BANK_TRANSFER|CHEQUE|ONLINE_GATEWAY",
    "status": "PENDING|SUCCESS|FAILED|REVERSED|...",
    "source": "PORTAL|STAFF_APP|CUSTOMER_APP|WEBHOOK|SYSTEM",
    "paidAt": "ISO"
  }
}
```

#### `POST /api/v1/admin/payments/:paymentId/share-whatsapp`
- **Auth:** Bearer TENANT_USER
- **Path params:** `paymentId`
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

#### `POST /api/v1/admin/redemptions/:redemptionId/approve`
- **Auth:** Bearer TENANT_USER
- **Path params:** `redemptionId`
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
    "_id": "red_...",
    "schemeId": "sch_...",
    "closureType": "MATURITY_REDEMPTION|PREMATURE_CLOSURE",
    "mode": "CASH|GOLD_HANDOVER|PURCHASE_ADJUSTMENT",
    "status": "REQUESTED|PENDING_APPROVAL|APPROVED|COMPLETED|REJECTED",
    "settlementPaise": 0
  }
}
```

#### `POST /api/v1/admin/redemptions/:redemptionId/complete`
- **Auth:** Bearer TENANT_USER
- **Path params:** `redemptionId`
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
    "_id": "red_...",
    "schemeId": "sch_...",
    "closureType": "MATURITY_REDEMPTION|PREMATURE_CLOSURE",
    "mode": "CASH|GOLD_HANDOVER|PURCHASE_ADJUSTMENT",
    "status": "REQUESTED|PENDING_APPROVAL|APPROVED|COMPLETED|REJECTED",
    "settlementPaise": 0
  }
}
```

#### `POST /api/v1/admin/redemptions/:redemptionId/reject`
- **Auth:** Bearer TENANT_USER
- **Path params:** `redemptionId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "reason": "string?"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "red_...",
    "schemeId": "sch_...",
    "closureType": "MATURITY_REDEMPTION|PREMATURE_CLOSURE",
    "mode": "CASH|GOLD_HANDOVER|PURCHASE_ADJUSTMENT",
    "status": "REQUESTED|PENDING_APPROVAL|APPROVED|COMPLETED|REJECTED",
    "settlementPaise": 0
  }
}
```

#### `POST /api/v1/admin/scheme-plans`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "name": "string",
  "code": "ABC",
  "valueBasis": "CASH|GOLD_WEIGHT",
  "paymentPattern": "FIXED|FLEXIBLE",
  "durationMonths": 11,
  "installmentCount": 11,
  "amountRules": {},
  "scheduleRules": {},
  "paymentRules": {},
  "flexibleRules": null,
  "goldRules": null,
  "redemptionRules": {},
  "availability": {},
  "status": "DRAFT"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "spl_...",
    "tenantId": "tnt_...",
    "name": "string",
    "code": "ABC",
    "valueBasis": "CASH|GOLD_WEIGHT",
    "paymentPattern": "FIXED|FLEXIBLE",
    "durationMonths": 11,
    "installmentCount": 11,
    "amountRules": {},
    "scheduleRules": {},
    "paymentRules": {},
    "flexibleRules": null,
    "goldRules": null,
    "redemptionRules": {},
    "availability": {},
    "status": "DRAFT|ACTIVE|INACTIVE",
    "version": 1
  }
}
```

#### `POST /api/v1/admin/scheme-plans/:planId/activate`
- **Auth:** Bearer TENANT_USER
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
    "ok": true
  }
}
```

#### `POST /api/v1/admin/scheme-plans/:planId/deactivate`
- **Auth:** Bearer TENANT_USER
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
    "ok": true
  }
}
```

#### `POST /api/v1/admin/scheme-plans/:planId/duplicate`
- **Auth:** Bearer TENANT_USER
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
    "ok": true
  }
}
```

#### `POST /api/v1/admin/scheme-plans/preview-schedule`
- **Auth:** Bearer TENANT_USER
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

#### `POST /api/v1/admin/schemes/:schemeId/close-premature`
- **Auth:** Bearer TENANT_USER
- **Path params:** `schemeId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "mode": "CASH|GOLD_HANDOVER|PURCHASE_ADJUSTMENT",
  "modeDetails": {},
  "expectedVersion": 1
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "red_...",
    "schemeId": "sch_...",
    "closureType": "MATURITY_REDEMPTION|PREMATURE_CLOSURE",
    "mode": "CASH|GOLD_HANDOVER|PURCHASE_ADJUSTMENT",
    "status": "REQUESTED|PENDING_APPROVAL|APPROVED|COMPLETED|REJECTED",
    "settlementPaise": 0
  }
}
```

#### `POST /api/v1/admin/schemes/:schemeId/recompute`
- **Auth:** Bearer TENANT_USER
- **Path params:** `schemeId`
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

#### `POST /api/v1/admin/schemes/:schemeId/redeem`
- **Auth:** Bearer TENANT_USER
- **Path params:** `schemeId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "mode": "CASH|GOLD_HANDOVER|PURCHASE_ADJUSTMENT",
  "modeDetails": {},
  "expectedVersion": 1
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "red_...",
    "schemeId": "sch_...",
    "closureType": "MATURITY_REDEMPTION|PREMATURE_CLOSURE",
    "mode": "CASH|GOLD_HANDOVER|PURCHASE_ADJUSTMENT",
    "status": "REQUESTED|PENDING_APPROVAL|APPROVED|COMPLETED|REJECTED",
    "settlementPaise": 0
  }
}
```

#### `POST /api/v1/admin/schemes/enrol`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "customerId": "cus_...",
  "planId": "spl_...",
  "branchId": "brn_?",
  "installmentAmountPaise": "number?",
  "firstInstallmentMode": "COLLECT_NOW|START_NEXT_CYCLE",
  "firstInstallmentAction": "RECORD_MANUAL_PAYMENT|CREATE_PAYMENT_LINK?",
  "payment": {}
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "sch_...",
    "tenantId": "tnt_...",
    "customerId": "cus_...",
    "planId": "spl_...",
    "enrollmentNumber": "string",
    "status": "ACTIVE|LOCKED|DEFAULTED|MATURED|REDEEMED|CLOSED_PREMATURE",
    "startDate": "YYYY-MM-DD",
    "maturityDate": "YYYY-MM-DD",
    "installmentAmountPaise": 0,
    "installments": [],
    "cycles": [],
    "positionVersion": 1,
    "version": 1
  }
}
```

#### `POST /api/v1/admin/schemes/enrol/validate`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "customerId": "cus_...",
  "planId": "spl_...",
  "branchId": "brn_?",
  "installmentAmountPaise": "number?",
  "firstInstallmentMode": "COLLECT_NOW|START_NEXT_CYCLE",
  "firstInstallmentAction": "RECORD_MANUAL_PAYMENT|CREATE_PAYMENT_LINK?",
  "payment": {}
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "valid": true,
    "preview": {
      "startDate": "YYYY-MM-DD",
      "maturityDate": "YYYY-MM-DD",
      "installmentAmountPaise": 0
    }
  }
}
```

### Admin — Operations

#### `GET /api/v1/admin/cash/handovers`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/cash/handovers/:handoverId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `handoverId`
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
    "_id": "csh_...",
    "staffId": "usr_...",
    "amountPaise": 1,
    "initiator": "STAFF|ADMIN",
    "status": "PENDING|ACCEPTED|DISCREPANCY|REJECTED"
  }
}
```

#### `GET /api/v1/admin/cash/handovers/:handoverId/audit-events`
- **Auth:** Bearer TENANT_USER
- **Path params:** `handoverId`
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

#### `GET /api/v1/admin/cash/overview`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/cash/report`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/cash/staff-balances`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/cash/staff-balances/:staffId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `staffId`
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

#### `GET /api/v1/admin/grievances`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/grievances/:grievanceId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `grievanceId`
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
    "_id": "grv_...",
    "ticketNumber": "string",
    "category": "PAYMENT|...",
    "priority": "NORMAL",
    "status": "OPEN|...",
    "subject": "string",
    "description": "string",
    "messages": [],
    "version": 1
  }
}
```

#### `GET /api/v1/admin/grievances/:grievanceId/audit-events`
- **Auth:** Bearer TENANT_USER
- **Path params:** `grievanceId`
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

#### `GET /api/v1/admin/messaging/messages`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/messaging/messages/:messageId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `messageId`
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
    "_id": "msg_...",
    "type": "PAYMENT_SUCCESS|...",
    "status": "QUEUED|SENT|DELIVERED|READ|FAILED",
    "channel": "WHATSAPP|SMS|PUSH|EMAIL"
  }
}
```

#### `GET /api/v1/admin/messaging/opt-outs`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/messaging/summary`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/messaging/templates`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/messaging/templates/:messageType/preview`
- **Auth:** Bearer TENANT_USER
- **Path params:** `messageType`
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

#### `GET /api/v1/admin/reminders/config`
- **Auth:** Bearer TENANT_USER
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

#### `POST /api/v1/admin/cash/adjustments`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "staffId": "usr_...",
  "direction": "CREDIT|DEBIT",
  "amountPaise": 1,
  "reason": "string"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "cad_...",
    "staffId": "usr_...",
    "direction": "CREDIT|DEBIT",
    "amountPaise": 1,
    "reason": "string"
  }
}
```

#### `POST /api/v1/admin/cash/handovers`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "amountPaise": 1,
  "remarks": "string?",
  "staffId": "usr_?",
  "branchId": "brn_?"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "csh_...",
    "staffId": "usr_...",
    "amountPaise": 1,
    "initiator": "STAFF|ADMIN",
    "status": "PENDING|ACCEPTED|DISCREPANCY|REJECTED"
  }
}
```

#### `POST /api/v1/admin/cash/handovers/:handoverId/accept`
- **Auth:** Bearer TENANT_USER
- **Path params:** `handoverId`
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

#### `POST /api/v1/admin/cash/handovers/:handoverId/reject`
- **Auth:** Bearer TENANT_USER
- **Path params:** `handoverId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "reason": "string?"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "red_...",
    "schemeId": "sch_...",
    "closureType": "MATURITY_REDEMPTION|PREMATURE_CLOSURE",
    "mode": "CASH|GOLD_HANDOVER|PURCHASE_ADJUSTMENT",
    "status": "REQUESTED|PENDING_APPROVAL|APPROVED|COMPLETED|REJECTED",
    "settlementPaise": 0
  }
}
```

#### `POST /api/v1/admin/grievances/:grievanceId/assign`
- **Auth:** Bearer TENANT_USER
- **Path params:** `grievanceId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "assigneeId": "usr_..."
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "grv_...",
    "ticketNumber": "string",
    "category": "PAYMENT|...",
    "priority": "NORMAL",
    "status": "OPEN|...",
    "subject": "string",
    "description": "string",
    "messages": [],
    "version": 1
  }
}
```

#### `POST /api/v1/admin/grievances/:grievanceId/messages`
- **Auth:** Bearer TENANT_USER
- **Path params:** `grievanceId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "body": "string",
  "messageType": "PUBLIC_REPLY|INTERNAL_NOTE|SYSTEM_EVENT",
  "attachmentUploadIds": [],
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "grv_...",
    "ticketNumber": "string",
    "category": "PAYMENT|...",
    "priority": "NORMAL",
    "status": "OPEN|...",
    "subject": "string",
    "description": "string",
    "messages": [],
    "version": 1
  }
}
```

#### `POST /api/v1/admin/grievances/:grievanceId/priority`
- **Auth:** Bearer TENANT_USER
- **Path params:** `grievanceId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "priority": "LOW|NORMAL|HIGH|URGENT"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "grv_...",
    "ticketNumber": "string",
    "category": "PAYMENT|...",
    "priority": "NORMAL",
    "status": "OPEN|...",
    "subject": "string",
    "description": "string",
    "messages": [],
    "version": 1
  }
}
```

#### `POST /api/v1/admin/grievances/:grievanceId/status`
- **Auth:** Bearer TENANT_USER
- **Path params:** `grievanceId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "status": "OPEN|IN_PROGRESS|WAITING_FOR_CUSTOMER|RESOLVED|CLOSED"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "grv_...",
    "ticketNumber": "string",
    "category": "PAYMENT|...",
    "priority": "NORMAL",
    "status": "OPEN|...",
    "subject": "string",
    "description": "string",
    "messages": [],
    "version": 1
  }
}
```

#### `POST /api/v1/admin/messaging/messages/:messageId/resend`
- **Auth:** Bearer TENANT_USER
- **Path params:** `messageId`
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

#### `POST /api/v1/admin/messaging/messages/bulk-resend`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "messageIds": [
    "msg_..."
  ]
}
```
- **Response (202):**
```json
{
  "success": true,
  "data": {
    "queued": 0
  }
}
```

#### `PUT /api/v1/admin/reminders/config`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "enabled": true,
  "dueOffsetDays": 0,
  "overdueOffsetDays": 0
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "enabled": true,
    "dueOffsetDays": 0,
    "overdueOffsetDays": 0
  }
}
```

### Admin — Analytics & exports

#### `GET /api/v1/admin/audit-events`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/dashboard/activity`
- **Auth:** Bearer TENANT_USER
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
      "type": "string",
      "entityId": "string",
      "at": "ISO"
    }
  ]
}
```

#### `GET /api/v1/admin/dashboard/charts/:chartKey`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/dashboard/summary`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/dues`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/dues/count`
- **Auth:** Bearer TENANT_USER
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
    "count": 0
  }
}
```

#### `GET /api/v1/admin/exports`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/exports/:exportId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `exportId`
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
    "_id": "exp_...",
    "type": "DUE|...",
    "status": "QUEUED|PROCESSING|READY|FAILED",
    "filters": {},
    "downloadUrl": "string?"
  }
}
```

#### `GET /api/v1/admin/maturities`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/maturities/calendar`
- **Auth:** Bearer TENANT_USER
- **Query:** month=YYYY-MM?
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
      "date": "YYYY-MM-DD",
      "count": 0
    }
  ]
}
```

#### `GET /api/v1/admin/overdues`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/admin/reports/:reportKey`
- **Auth:** Bearer TENANT_USER
- **Path params:** `reportKey`
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

#### `POST /api/v1/admin/dues/bulk-send-links`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "schemeIds": [
    "sch_..."
  ]
}
```
- **Response (202):**
```json
{
  "success": true,
  "data": {
    "accepted": 0
  }
}
```

#### `POST /api/v1/admin/exports`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "type": "DUE|OVERDUE|DEFAULTER|MATURITY|COLLECTION|OUTSTANDING|GOLD_ACCRUAL|STAFF_PERFORMANCE|CUSTOMER|SCHEME|AUDIT",
  "filters": {
    "from": "YYYY-MM-DD?",
    "to": "YYYY-MM-DD?"
  },
  "format": "CSV|PDF"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "exp_...",
    "type": "DUE|...",
    "status": "QUEUED|PROCESSING|READY|FAILED",
    "filters": {},
    "downloadUrl": "string?"
  }
}
```

#### `POST /api/v1/admin/overdues/bulk-send-reminders`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "schemeIds": [
    "sch_..."
  ]
}
```
- **Response (202):**
```json
{
  "success": true,
  "data": {
    "accepted": 0
  }
}
```

### Staff

#### `DELETE /api/v1/staff/customers/:customerId/nominee`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
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

#### `DELETE /api/v1/staff/devices/fcm-token`
- **Auth:** Bearer TENANT_USER
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
    "removed": true
  }
}
```

#### `GET /api/v1/staff/cash/collections`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/staff/cash/handovers`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/staff/cash/handovers/:handoverId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `handoverId`
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
    "_id": "csh_...",
    "staffId": "usr_...",
    "amountPaise": 1,
    "initiator": "STAFF|ADMIN",
    "status": "PENDING|ACCEPTED|DISCREPANCY|REJECTED"
  }
}
```

#### `GET /api/v1/staff/cash/summary`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/staff/collections/summary`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/staff/customers`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/staff/customers/:customerId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
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
    "_id": "cus_...",
    "tenantId": "tnt_...",
    "branchId": "brn_...",
    "customerNumber": "C0001",
    "name": "string",
    "mobile": "+91...",
    "email": "string?",
    "status": "ACTIVE|BLOCKED|INACTIVE",
    "kyc": {},
    "nominee": {},
    "version": 1,
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}
```

#### `GET /api/v1/staff/customers/:customerId/audit-events`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
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

#### `GET /api/v1/staff/customers/:customerId/nominee`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
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
    "name": "string",
    "relationship": "SPOUSE"
  }
}
```

#### `GET /api/v1/staff/customers/check-mobile`
- **Auth:** Bearer TENANT_USER
- **Query:** mobile=
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
    "exists": false
  }
}
```

#### `GET /api/v1/staff/dashboard/summary`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/staff/dues`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/staff/gold-rate/current`
- **Auth:** Bearer TENANT_USER
- **Query:** branchId?
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
    "_id": "grt_...",
    "ratePerGramPaise": 1,
    "effectiveDate": "YYYY-MM-DD",
    "purity": "22K"
  }
}
```

#### `GET /api/v1/staff/grievances`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/staff/grievances/:grievanceId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `grievanceId`
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
    "_id": "grv_...",
    "ticketNumber": "string",
    "category": "PAYMENT|...",
    "priority": "NORMAL",
    "status": "OPEN|...",
    "subject": "string",
    "description": "string",
    "messages": [],
    "version": 1
  }
}
```

#### `GET /api/v1/staff/home`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/staff/notifications`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/staff/overdues`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/staff/payments`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/staff/profile`
- **Auth:** Bearer TENANT_USER
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
}
```

#### `GET /api/v1/staff/scheme-plans`
- **Auth:** Bearer TENANT_USER
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

#### `GET /api/v1/staff/schemes/:schemeId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `schemeId`
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
    "_id": "sch_...",
    "tenantId": "tnt_...",
    "customerId": "cus_...",
    "planId": "spl_...",
    "enrollmentNumber": "string",
    "status": "ACTIVE|LOCKED|DEFAULTED|MATURED|REDEEMED|CLOSED_PREMATURE",
    "startDate": "YYYY-MM-DD",
    "maturityDate": "YYYY-MM-DD",
    "installmentAmountPaise": 0,
    "installments": [],
    "cycles": [],
    "positionVersion": 1,
    "version": 1
  }
}
```

#### `GET /api/v1/staff/schemes/:schemeId/passbook`
- **Auth:** Bearer TENANT_USER
- **Path params:** `schemeId`
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
    "scheme": {
      "_id": "sch_...",
      "tenantId": "tnt_...",
      "customerId": "cus_...",
      "planId": "spl_...",
      "enrollmentNumber": "string",
      "status": "ACTIVE|LOCKED|DEFAULTED|MATURED|REDEEMED|CLOSED_PREMATURE",
      "startDate": "YYYY-MM-DD",
      "maturityDate": "YYYY-MM-DD",
      "installmentAmountPaise": 0,
      "installments": [],
      "cycles": [],
      "positionVersion": 1,
      "version": 1
    },
    "ledger": [
      {
        "_id": "led_...",
        "schemeId": "sch_...",
        "type": "INSTALLMENT_PAYMENT|...",
        "sequence": 1,
        "amountPaise": 0,
        "effectiveAt": "ISO"
      }
    ]
  }
}
```

#### `GET /api/v1/staff/schemes/:schemeId/payable-range`
- **Auth:** Bearer TENANT_USER
- **Path params:** `schemeId`
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
    "minPaise": 0,
    "maxPaise": 0,
    "incrementPaise": 0,
    "positionVersion": 1
  }
}
```

#### `PATCH /api/v1/staff/customers/:customerId`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "branchId": "brn_?",
  "name": "string",
  "mobile": "+91...",
  "email": "email?",
  "dateOfBirth": "string?",
  "address": "string?",
  "passbookNumber": "string?",
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "cus_...",
    "tenantId": "tnt_...",
    "branchId": "brn_...",
    "customerNumber": "C0001",
    "name": "string",
    "mobile": "+91...",
    "email": "string?",
    "status": "ACTIVE|BLOCKED|INACTIVE",
    "kyc": {},
    "nominee": {},
    "version": 1,
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}
```

#### `POST /api/v1/staff/cash/handovers`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "amountPaise": 1,
  "remarks": "string?",
  "staffId": "usr_?",
  "branchId": "brn_?"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "csh_...",
    "staffId": "usr_...",
    "amountPaise": 1,
    "initiator": "STAFF|ADMIN",
    "status": "PENDING|ACCEPTED|DISCREPANCY|REJECTED"
  }
}
```

#### `POST /api/v1/staff/cash/handovers/:handoverId/cancel`
- **Auth:** Bearer TENANT_USER
- **Path params:** `handoverId`
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

#### `POST /api/v1/staff/customers`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "branchId": "brn_?",
  "name": "string",
  "mobile": "+91...",
  "email": "email?",
  "dateOfBirth": "string?",
  "address": "string?",
  "passbookNumber": "string?"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "cus_...",
    "tenantId": "tnt_...",
    "branchId": "brn_...",
    "customerNumber": "C0001",
    "name": "string",
    "mobile": "+91...",
    "email": "string?",
    "status": "ACTIVE|BLOCKED|INACTIVE",
    "kyc": {},
    "nominee": {},
    "version": 1,
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}
```

#### `POST /api/v1/staff/devices/fcm-token`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "token": "string",
  "platform": "android|ios|web"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "registered": true
  }
}
```

#### `POST /api/v1/staff/grievances/:grievanceId/messages`
- **Auth:** Bearer TENANT_USER
- **Path params:** `grievanceId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "body": "string",
  "messageType": "PUBLIC_REPLY|INTERNAL_NOTE|SYSTEM_EVENT",
  "attachmentUploadIds": [],
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "grv_...",
    "ticketNumber": "string",
    "category": "PAYMENT|...",
    "priority": "NORMAL",
    "status": "OPEN|...",
    "subject": "string",
    "description": "string",
    "messages": [],
    "version": 1
  }
}
```

#### `POST /api/v1/staff/payment-links`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "schemeId": "sch_...",
  "amountPaise": 1,
  "targetCycle": "YYYY-MM?",
  "positionVersion": 1,
  "mobile": "+91...?",
  "redirectUrl": "url?"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "plk_...",
    "schemeId": "sch_?",
    "amountPaise": 1,
    "status": "CREATED|SENT|OPENED|PAID|EXPIRED|CANCELLED",
    "expiresAt": "ISO",
    "paymentId": "pay_?"
  }
}
```

#### `POST /api/v1/staff/payments`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "schemeId": "sch_...",
  "amountPaise": 1,
  "mode": "CASH|CARD|UPI|BANK_TRANSFER|CHEQUE",
  "targetCycle": "YYYY-MM?",
  "expectedVersion": 1,
  "positionVersion": 1,
  "reference": "string?",
  "remarks": "string?"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "pay_...",
    "schemeId": "sch_...",
    "customerId": "cus_...",
    "receiptNumber": "string",
    "amountPaise": 1,
    "mode": "CASH|CARD|UPI|BANK_TRANSFER|CHEQUE|ONLINE_GATEWAY",
    "status": "PENDING|SUCCESS|FAILED|REVERSED|...",
    "source": "PORTAL|STAFF_APP|CUSTOMER_APP|WEBHOOK|SYSTEM",
    "paidAt": "ISO"
  }
}
```

#### `POST /api/v1/staff/payments/:paymentId/share-whatsapp`
- **Auth:** Bearer TENANT_USER
- **Path params:** `paymentId`
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

#### `POST /api/v1/staff/schemes/enrol`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "customerId": "cus_...",
  "planId": "spl_...",
  "branchId": "brn_?",
  "installmentAmountPaise": "number?",
  "firstInstallmentMode": "COLLECT_NOW|START_NEXT_CYCLE",
  "firstInstallmentAction": "RECORD_MANUAL_PAYMENT|CREATE_PAYMENT_LINK?",
  "payment": {}
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "sch_...",
    "tenantId": "tnt_...",
    "customerId": "cus_...",
    "planId": "spl_...",
    "enrollmentNumber": "string",
    "status": "ACTIVE|LOCKED|DEFAULTED|MATURED|REDEEMED|CLOSED_PREMATURE",
    "startDate": "YYYY-MM-DD",
    "maturityDate": "YYYY-MM-DD",
    "installmentAmountPaise": 0,
    "installments": [],
    "cycles": [],
    "positionVersion": 1,
    "version": 1
  }
}
```

#### `POST /api/v1/staff/schemes/enrol/validate`
- **Auth:** Bearer TENANT_USER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "customerId": "cus_...",
  "planId": "spl_...",
  "branchId": "brn_?",
  "installmentAmountPaise": "number?",
  "firstInstallmentMode": "COLLECT_NOW|START_NEXT_CYCLE",
  "firstInstallmentAction": "RECORD_MANUAL_PAYMENT|CREATE_PAYMENT_LINK?",
  "payment": {}
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "valid": true,
    "preview": {
      "startDate": "YYYY-MM-DD",
      "maturityDate": "YYYY-MM-DD",
      "installmentAmountPaise": 0
    }
  }
}
```

#### `PUT /api/v1/staff/customers/:customerId/kyc`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "type": "AADHAAR|PAN",
  "number": "string?",
  "frontUploadId": "upl_?",
  "backUploadId": "upl_?",
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "cus_...",
    "tenantId": "tnt_...",
    "branchId": "brn_...",
    "customerNumber": "C0001",
    "name": "string",
    "mobile": "+91...",
    "email": "string?",
    "status": "ACTIVE|BLOCKED|INACTIVE",
    "kyc": {},
    "nominee": {},
    "version": 1,
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}
```

#### `PUT /api/v1/staff/customers/:customerId/nominee`
- **Auth:** Bearer TENANT_USER
- **Path params:** `customerId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "name": "string",
  "relationship": "SPOUSE|PARENT|CHILD|SIBLING|RELATIVE|FRIEND|OTHER",
  "mobile": "+91...?",
  "dateOfBirth": "string?",
  "address": "string?",
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "cus_...",
    "tenantId": "tnt_...",
    "branchId": "brn_...",
    "customerNumber": "C0001",
    "name": "string",
    "mobile": "+91...",
    "email": "string?",
    "status": "ACTIVE|BLOCKED|INACTIVE",
    "kyc": {},
    "nominee": {},
    "version": 1,
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}
```

### Customer App

#### `DELETE /api/v1/app/devices/fcm-token`
- **Auth:** Bearer CUSTOMER
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
    "removed": true
  }
}
```

#### `GET /api/v1/app/auth/me`
- **Auth:** Bearer CUSTOMER
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
    "_id": "cus_...",
    "tenantId": "tnt_...",
    "branchId": "brn_...",
    "customerNumber": "C0001",
    "name": "string",
    "mobile": "+91...",
    "email": "string?",
    "status": "ACTIVE|BLOCKED|INACTIVE",
    "kyc": {},
    "nominee": {},
    "version": 1,
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}
```

#### `GET /api/v1/app/branches`
- **Auth:** Bearer CUSTOMER
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

#### `GET /api/v1/app/gold-rate/current`
- **Auth:** Bearer CUSTOMER
- **Query:** branchId?
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
    "_id": "grt_...",
    "ratePerGramPaise": 1,
    "effectiveDate": "YYYY-MM-DD",
    "purity": "22K"
  }
}
```

#### `GET /api/v1/app/gold-rate/history`
- **Auth:** Bearer CUSTOMER
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
      "_id": "grt_...",
      "ratePerGramPaise": 1,
      "effectiveDate": "YYYY-MM-DD",
      "purity": "22K"
    }
  ]
}
```

#### `GET /api/v1/app/grievances`
- **Auth:** Bearer CUSTOMER
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

#### `GET /api/v1/app/grievances/:grievanceId`
- **Auth:** Bearer CUSTOMER
- **Path params:** `grievanceId`
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
    "_id": "grv_...",
    "ticketNumber": "string",
    "category": "PAYMENT|...",
    "priority": "NORMAL",
    "status": "OPEN|...",
    "subject": "string",
    "description": "string",
    "messages": [],
    "version": 1
  }
}
```

#### `GET /api/v1/app/home`
- **Auth:** Bearer CUSTOMER
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

#### `GET /api/v1/app/notifications`
- **Auth:** Bearer CUSTOMER
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

#### `GET /api/v1/app/payment-intents/:intentId`
- **Auth:** Bearer CUSTOMER
- **Path params:** `intentId`
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
    "_id": "pmi_...",
    "schemeId": "sch_?",
    "amountPaise": 1,
    "positionVersion": 1,
    "status": "PENDING|SUCCEEDED|FAILED|EXPIRED|CANCELLED",
    "providerOrderId": "string?",
    "paymentId": "pay_?"
  }
}
```

#### `GET /api/v1/app/payments`
- **Auth:** Bearer CUSTOMER
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

#### `GET /api/v1/app/payments/:linkId/status`
- **Auth:** Bearer CUSTOMER
- **Path params:** `linkId`
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

#### `GET /api/v1/app/payments/:paymentId/receipt`
- **Auth:** Bearer CUSTOMER
- **Path params:** `paymentId`
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
    "contentType": "application/pdf",
    "url": "string?"
  }
}
```

#### `GET /api/v1/app/profile`
- **Auth:** Bearer CUSTOMER
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
    "_id": "cus_...",
    "tenantId": "tnt_...",
    "branchId": "brn_...",
    "customerNumber": "C0001",
    "name": "string",
    "mobile": "+91...",
    "email": "string?",
    "status": "ACTIVE|BLOCKED|INACTIVE",
    "kyc": {},
    "nominee": {},
    "version": 1,
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}
```

#### `GET /api/v1/app/scheme-plans`
- **Auth:** Bearer CUSTOMER
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

#### `GET /api/v1/app/scheme-plans/:planId`
- **Auth:** Bearer CUSTOMER
- **Path params:** `planId`
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
    "_id": "spl_...",
    "tenantId": "tnt_...",
    "name": "string",
    "code": "ABC",
    "valueBasis": "CASH|GOLD_WEIGHT",
    "paymentPattern": "FIXED|FLEXIBLE",
    "durationMonths": 11,
    "installmentCount": 11,
    "amountRules": {},
    "scheduleRules": {},
    "paymentRules": {},
    "flexibleRules": null,
    "goldRules": null,
    "redemptionRules": {},
    "availability": {},
    "status": "DRAFT|ACTIVE|INACTIVE",
    "version": 1
  }
}
```

#### `GET /api/v1/app/schemes`
- **Auth:** Bearer CUSTOMER
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

#### `GET /api/v1/app/schemes/:schemeId`
- **Auth:** Bearer CUSTOMER
- **Path params:** `schemeId`
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
    "_id": "sch_...",
    "tenantId": "tnt_...",
    "customerId": "cus_...",
    "planId": "spl_...",
    "enrollmentNumber": "string",
    "status": "ACTIVE|LOCKED|DEFAULTED|MATURED|REDEEMED|CLOSED_PREMATURE",
    "startDate": "YYYY-MM-DD",
    "maturityDate": "YYYY-MM-DD",
    "installmentAmountPaise": 0,
    "installments": [],
    "cycles": [],
    "positionVersion": 1,
    "version": 1
  }
}
```

#### `GET /api/v1/app/schemes/:schemeId/passbook`
- **Auth:** Bearer CUSTOMER
- **Path params:** `schemeId`
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
    "scheme": {
      "_id": "sch_...",
      "tenantId": "tnt_...",
      "customerId": "cus_...",
      "planId": "spl_...",
      "enrollmentNumber": "string",
      "status": "ACTIVE|LOCKED|DEFAULTED|MATURED|REDEEMED|CLOSED_PREMATURE",
      "startDate": "YYYY-MM-DD",
      "maturityDate": "YYYY-MM-DD",
      "installmentAmountPaise": 0,
      "installments": [],
      "cycles": [],
      "positionVersion": 1,
      "version": 1
    },
    "ledger": [
      {
        "_id": "led_...",
        "schemeId": "sch_...",
        "type": "INSTALLMENT_PAYMENT|...",
        "sequence": 1,
        "amountPaise": 0,
        "effectiveAt": "ISO"
      }
    ]
  }
}
```

#### `GET /api/v1/app/schemes/:schemeId/payable-range`
- **Auth:** Bearer CUSTOMER
- **Path params:** `schemeId`
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
    "minPaise": 0,
    "maxPaise": 0,
    "incrementPaise": 0,
    "positionVersion": 1
  }
}
```

#### `GET /api/v1/app/schemes/:schemeId/settlement-preview`
- **Auth:** Bearer CUSTOMER
- **Path params:** `schemeId`
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
    "principalPaise": 0,
    "benefitPaise": 0,
    "penaltyPaise": 0,
    "settlementPaise": 0
  }
}
```

#### `PATCH /api/v1/app/profile`
- **Auth:** Bearer CUSTOMER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "name": "string?",
  "email": "string?",
  "dateOfBirth": "string?",
  "address": "string?"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "cus_...",
    "tenantId": "tnt_...",
    "branchId": "brn_...",
    "customerNumber": "C0001",
    "name": "string",
    "mobile": "+91...",
    "email": "string?",
    "status": "ACTIVE|BLOCKED|INACTIVE",
    "kyc": {},
    "nominee": {},
    "version": 1,
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}
```

#### `POST /api/v1/app/auth/logout`
- **Auth:** Bearer CUSTOMER
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

#### `POST /api/v1/app/auth/refresh`
- **Auth:** Bearer CUSTOMER
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

#### `POST /api/v1/app/devices/fcm-token`
- **Auth:** Bearer CUSTOMER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "token": "string",
  "platform": "android|ios|web"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "registered": true
  }
}
```

#### `POST /api/v1/app/grievances`
- **Auth:** Bearer CUSTOMER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "category": "PAYMENT|RECEIPT|SCHEME_RULE|GOLD_CREDIT|MATURITY|REDEMPTION|KYC|WHATSAPP|STAFF_SERVICE|OTHER",
  "subject": "string",
  "description": "string",
  "relatedEntity": {
    "type": "PAYMENT|SCHEME|REDEMPTION",
    "id": "string"
  },
  "attachmentUploadIds": []
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "grv_...",
    "ticketNumber": "string",
    "category": "PAYMENT|...",
    "priority": "NORMAL",
    "status": "OPEN|...",
    "subject": "string",
    "description": "string",
    "messages": [],
    "version": 1
  }
}
```

#### `POST /api/v1/app/grievances/:grievanceId/messages`
- **Auth:** Bearer CUSTOMER
- **Path params:** `grievanceId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "body": "string",
  "messageType": "PUBLIC_REPLY|INTERNAL_NOTE|SYSTEM_EVENT",
  "attachmentUploadIds": [],
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "grv_...",
    "ticketNumber": "string",
    "category": "PAYMENT|...",
    "priority": "NORMAL",
    "status": "OPEN|...",
    "subject": "string",
    "description": "string",
    "messages": [],
    "version": 1
  }
}
```

#### `POST /api/v1/app/grievances/:grievanceId/reopen`
- **Auth:** Bearer CUSTOMER
- **Path params:** `grievanceId`
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

#### `POST /api/v1/app/notifications/:id/read`
- **Auth:** Bearer CUSTOMER
- **Path params:** `id`
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

#### `POST /api/v1/app/notifications/read-all`
- **Auth:** Bearer CUSTOMER
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

#### `POST /api/v1/app/payment-intents/:intentId/cancel`
- **Auth:** Bearer CUSTOMER
- **Path params:** `intentId`
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

#### `POST /api/v1/app/schemes/:schemeId/pay`
- **Auth:** Bearer CUSTOMER
- **Path params:** `schemeId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "amountPaise": 1,
  "targetCycle": "YYYY-MM?",
  "positionVersion": 1,
  "redirectUrl": "url?",
  "mobile": "+91...?"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "kind": "PaymentIntent|PaymentLink"
  }
}
```

#### `POST /api/v1/app/schemes/:schemeId/payment-intents`
- **Auth:** Bearer CUSTOMER
- **Path params:** `schemeId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "amountPaise": 1,
  "targetCycle": "YYYY-MM?",
  "positionVersion": 1,
  "redirectUrl": "url?",
  "mobile": "+91...?"
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "pmi_...",
    "schemeId": "sch_?",
    "amountPaise": 1,
    "positionVersion": 1,
    "status": "PENDING|SUCCEEDED|FAILED|EXPIRED|CANCELLED",
    "providerOrderId": "string?",
    "paymentId": "pay_...",
    "redirectUrl": "url?"
  }
}
```

#### `POST /api/v1/app/schemes/:schemeId/redemption-request`
- **Auth:** Bearer CUSTOMER
- **Path params:** `schemeId`
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "mode": "CASH|GOLD_HANDOVER|PURCHASE_ADJUSTMENT",
  "modeDetails": {},
  "expectedVersion": 1
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "red_...",
    "schemeId": "sch_...",
    "closureType": "MATURITY_REDEMPTION|PREMATURE_CLOSURE",
    "mode": "CASH|GOLD_HANDOVER|PURCHASE_ADJUSTMENT",
    "status": "REQUESTED|PENDING_APPROVAL|APPROVED|COMPLETED|REJECTED",
    "settlementPaise": 0
  }
}
```

#### `POST /api/v1/app/schemes/enrol`
- **Auth:** Bearer CUSTOMER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "customerId": "cus_...",
  "planId": "spl_...",
  "branchId": "brn_?",
  "installmentAmountPaise": "number?",
  "firstInstallmentMode": "COLLECT_NOW|START_NEXT_CYCLE",
  "firstInstallmentAction": "RECORD_MANUAL_PAYMENT|CREATE_PAYMENT_LINK?",
  "payment": {}
}
```
- **Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "sch_...",
    "tenantId": "tnt_...",
    "customerId": "cus_...",
    "planId": "spl_...",
    "enrollmentNumber": "string",
    "status": "ACTIVE|LOCKED|DEFAULTED|MATURED|REDEEMED|CLOSED_PREMATURE",
    "startDate": "YYYY-MM-DD",
    "maturityDate": "YYYY-MM-DD",
    "installmentAmountPaise": 0,
    "installments": [],
    "cycles": [],
    "positionVersion": 1,
    "version": 1
  }
}
```

#### `PUT /api/v1/app/profile/kyc`
- **Auth:** Bearer CUSTOMER
- **Query:** none
- **Idempotent:** yes
- **Request body:**
```json
{
  "type": "AADHAAR|PAN",
  "number": "string?",
  "frontUploadId": "upl_?",
  "backUploadId": "upl_?",
  "expectedVersion": 1
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "cus_...",
    "tenantId": "tnt_...",
    "branchId": "brn_...",
    "customerNumber": "C0001",
    "name": "string",
    "mobile": "+91...",
    "email": "string?",
    "status": "ACTIVE|BLOCKED|INACTIVE",
    "kyc": {},
    "nominee": {},
    "version": 1,
    "createdAt": "ISO",
    "updatedAt": "ISO"
  }
}
```

### Webhooks

#### `POST /api/v1/webhooks/phonepe/:tenantId`
- **Auth:** provider signature (raw JSON body)
- **Path params:** `tenantId`
- **Query:** none
- **Idempotent:** no
- **Request body:**
```json
{
  "providerPayload": "raw JSON"
}
```
- **Response (200):**
```json
{
  "success": true,
  "data": {
    "received": true
  }
}
```

Documented: **279** routes. Leftovers: **0**.
