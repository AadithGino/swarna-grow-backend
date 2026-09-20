# Admin Panel API Contract

**Audience:** Tenant admin portal (`TENANT_USER` — owner, admin, branch manager). Collection agent app APIs are documented in [API_CONTRACT_STAFF.md](./API_CONTRACT_STAFF.md).

**Base:** `http://localhost:4000` · **Prefix:** `/api/v1` (except `/health*`)

> Money = integer **paise**. Weight = integer **mg**.

## Scope
- Tenant auth: `/auth/*`
- All `/admin/*` routes
- Collection agent app: `/staff/*` subset — see [API_CONTRACT_STAFF.md](./API_CONTRACT_STAFF.md) (this file retains full `/staff` entries for cross-reference)
- Public helpers used by admin web: password policy, tenant resolve, branch lookup
- Health checks

**Route count in this panel:** 188

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
