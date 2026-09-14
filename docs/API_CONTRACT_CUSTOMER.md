# Customer Web / App API Contract

**Audience:** Customer mobile app & customer web (`CUSTOMER`) + public pay/OTP surfaces

**Base:** `http://localhost:4000` · **Prefix:** `/api/v1` (except `/health*`)

> Money = integer **paise**. Weight = integer **mg**.

## Scope
- Customer auth OTP: `/public/auth/otp/*`, `/app/auth/*` if present
- All `/app/*` routes
- Public pay links: `/public/pay/*`
- App config: `/public/app-config`
- Tenant resolve / branches for login branding
- Health checks

**Route count in this panel:** 45

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
  "mode": "CASH|GOLD_HANDOVER|PURCHASE_ADJUSTMENT|TRANSFER_TO_SCHEME",
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
    "mode": "CASH|GOLD_HANDOVER|PURCHASE_ADJUSTMENT|TRANSFER_TO_SCHEME",
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

