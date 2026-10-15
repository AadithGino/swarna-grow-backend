# FCM — customer app integration (multi-brand, one Firebase project)

This document is for **backend/DevOps** and the **Flutter team**. It covers what credentials belong on the server, what stays in the app, and the HTTP API for FCM token lifecycle.

## Architecture (recommended)

- **One Firebase project** for all jeweller white-label customer apps.
- **Many Firebase app registrations** in that project (one Android package name + one iOS bundle ID per brand/flavor).
- **One Swarna Grow backend** — no per-jeweller backend fork.
- **One service account** on the server sends FCM to tokens from any app in that project.

Tenant isolation is on the **API** (login JWT + `tenantId` in the database), not separate Firebase projects per jeweller.

---

## What the Flutter / Firebase owner must give the backend team

Send these through a **secure channel** (1Password, vault, encrypted file — never Slack/email in plain text, never commit to git).

| Deliverable | Used where | Required? |
|-------------|------------|-----------|
| **Firebase project ID** | Server env `FCM_PROJECT_ID` | Yes |
| **Service account JSON key** (Firebase Admin SDK, FCM send permission) | Server env `FCM_SERVICE_ACCOUNT_JSON` | Yes |
| **Confirmation** that every store app’s `google-services.json` / `GoogleService-Info.plist` shows the **same `project_id`** as above | Cross-check only | Yes |
| **Inventory**: brand / `tenantCode`, Android `applicationId`, iOS bundle ID, staging vs prod | Ops checklist | Yes |
| **APNs**: `.p8` uploaded in Firebase Console (Key ID + Team ID) | Firebase only (not backend env) | Yes for iOS push |

### Do **not** send these for backend configuration

| File | Who uses it |
|------|-------------|
| `google-services.json` | Flutter Android build only |
| `GoogleService-Info.plist` | Flutter iOS build only |
| FCM registration token from a device | App registers via API after login — not a server bootstrap file |

The backend **never** needs mobile config files to **send** push. It only needs the **service account** for the **same** Firebase project those files point to.

### How to create the service account (Flutter/Firebase owner)

1. Firebase Console → Project settings → **Service accounts**.
2. Generate a new private key (JSON download).
3. JSON must include at least `project_id`, `client_email`, `private_key`.
4. Hand the file to backend; backend stores it in env (see below), not in the repo.

Optional sanity check: `project_id` inside the JSON must equal `FCM_PROJECT_ID` and match every app’s `project_id` in `google-services.json`.

---

## Backend configuration (shared Firebase project)

For **one project, many apps**, use **platform shared FCM** (default for white-label).

### 1. Environment variables (API + worker processes)

Set on **both** the HTTP API and **`npm run worker`** (FCM sends run in the message worker).

```env
FCM_SHARED_PROJECT_ENABLED=true
FCM_PROJECT_ID=your-firebase-project-id
FCM_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"firebase-adminsdk-...@....iam.gserviceaccount.com",...}
PROVIDER_MODE=live
```

Notes:

- `FCM_SERVICE_ACCOUNT_JSON` is the **entire** downloaded JSON as one line (escape newlines in `private_key` as `\n` if using `.env`).
- In production, prefer secret manager / injected env, not committed `.env`.
- With `FCM_SHARED_PROJECT_ENABLED=true`, every tenant **without** its own platform FCM integration uses this project to send.

### 2. Per-tenant Firebase (usually **not** used for white-label)

Platform API `PUT /api/v1/platform/tenants/:tenantId/integrations/fcm` can store sealed credentials per tenant. If set, that tenant’s pushes use **that** project instead of shared env.

For **one shared project + many apps**, leave per-tenant FCM **unset** for all jewellers. Mixing shared app tokens with a different tenant project will cause send failures.

### 3. Processes that must run

| Process | Role |
|---------|------|
| API | Accepts `POST/DELETE /app/devices/fcm-token` |
| `npm run worker` | Delivers FCM when notifications are queued |
| Redis | Rate limiting / dispatch (required in production) |

---

## Customer app API — FCM token management

Base path: **`/api/v1/app`**

Authentication: **`Authorization: Bearer <customer access token>`** (same JWT as other customer routes).

Tenant scope: determined from the **login session / JWT** (`tenantId`). Do **not** send `tenantCode` on register unless your auth layer already requires it elsewhere; the register endpoints bind the token to `req.auth.tenantId` and `req.auth.id` (customer id).

Customer app must be **writable** for the tenant (same rules as payments/profile); blocked tenants receive the same errors as other write routes.

### Register or update token

**`POST /api/v1/app/devices/fcm-token`**

| | |
|--|--|
| **Idempotent** | Yes — send header `X-Idempotency-Key` (unique per logical register, e.g. `fcm-register-{deviceId}-{date}` or UUID). |
| **When to call** | After login; on Firebase token refresh; on cold start if token changed. |

**Request body**

```json
{
  "fcmToken": "long-firebase-registration-token-from-sdk",
  "deviceId": "stable-id-per-install-same-as-login",
  "platform": "android",
  "appVersion": "1.2.0",
  "osVersion": "14",
  "deviceModel": "Pixel 8"
}
```

| Field | Required | Rules |
|-------|----------|--------|
| `fcmToken` | Yes | Min length 20 |
| `deviceId` | Yes | Min length 4; should match `deviceId` used at login |
| `platform` | Yes | `"android"` or `"ios"` |
| `appVersion` | No | Max 32 chars |
| `osVersion` | No | Max 32 chars |
| `deviceModel` | No | Max 64 chars |

If `deviceId` is omitted, the server falls back to `deviceId` on the auth context (when present).

**Response `200`**

```json
{
  "success": true,
  "data": {
    "registered": true,
    "deviceId": "stable-id-per-install-same-as-login",
    "replacedPreviousToken": true
  }
}
```

**Server behaviour (for implementers)**

- Upsert on `(tenantId, customerId, deviceId)`; new token replaces old for that device.
- Same FCM token registered under a **different** customer on the same tenant is detached from the previous customer (shared handset).
- Active devices per customer are capped (default 10); oldest may be revoked.

**Example**

```http
POST /api/v1/app/devices/fcm-token HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJ...
Content-Type: application/json
X-Idempotency-Key: fcm-register-device-01

{
  "fcmToken": "dXNlcl90b2tlbl9oZXJl...",
  "deviceId": "flutter-device-uuid",
  "platform": "ios",
  "appVersion": "1.0.0",
  "osVersion": "17.4",
  "deviceModel": "iPhone15,2"
}
```

### Remove token (logout)

**`DELETE /api/v1/app/devices/fcm-token`**

| | |
|--|--|
| **Idempotent** | No |
| **When to call** | Explicit logout; optional before uninstall |

**Request body**

```json
{
  "deviceId": "flutter-device-uuid"
}
```

**Response `200`**

```json
{
  "success": true,
  "data": {
    "removed": true,
    "deviceId": "flutter-device-uuid"
  }
}
```

Also revokes **sessions** for that `(customer, tenant, deviceId)`.

### Related session APIs

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/app/auth/devices` | List active sessions |
| DELETE | `/api/v1/app/auth/devices/:deviceId` | Revoke refresh family for a device (may also deregister FCM depending on client flow) |

Recommended Flutter flow on logout: **`DELETE /app/devices/fcm-token`** then clear local tokens / call auth logout.

---

## In-app notifications + push payload

The server maintains an in-app inbox and sends FCM in parallel for the same events.

### Inbox

```http
GET /api/v1/app/notifications?limit=50
POST /api/v1/app/notifications/:id/read
POST /api/v1/app/notifications/read-all
```

(`POST` read routes use `X-Idempotency-Key`.)

### FCM message shape (handle in Flutter)

Sends use FCM HTTP v1 with **both** `notification` (title/body) and **`data`** (all values **strings**).

Example payment success:

```json
{
  "notification": {
    "title": "Payment received",
    "body": "₹1,500 was credited to Flexible Gold Savings (ENR-123)."
  },
  "data": {
    "messageId": "msg_...",
    "messageType": "PAYMENT_SUCCESS",
    "schemeId": "sch_...",
    "paymentId": "pay_...",
    "deepLink": "/payments/pay_...",
    "jewellerName": "Ritu Gold"
  }
}
```

**Flutter integration**

- Show system banner when app is backgrounded/killed (`notification` block).
- On tap / foreground handling, read **`data.deepLink`** and route via your `customerRouteFor` (or equivalent) mapper.
- Map `messageType` to screens if `deepLink` is empty.
- Do not assume `data.type` or `data.tenantCode` — backend uses `messageType` and tenant is implicit from the logged-in app.

E-commerce and manual campaigns may set `deepLink` under `/shop/order/...` or custom paths from template params.

Gold-rate and promotion pushes also include string metadata in `data`: `rateId`, `rateSource`, `purity`, `ratePerGramPaise`, `schemeEffectiveDate`, `effectiveAt`, `branchId`, `productId`, `categoryId`, `campaignBusinessKey`. See `docs/FLUTTER_CUSTOMER_API_GUIDE.md` §11 for the full customer routing matrix.

---

## Checklist for Flutter developer

- [ ] All brand flavors use config files from the **same** Firebase `project_id`.
- [ ] iOS: APNs key configured in Firebase; test on physical device.
- [ ] `deviceId` stable per install; same value at login and FCM register.
- [ ] After successful login: `POST /api/v1/app/devices/fcm-token`.
- [ ] `FirebaseMessaging.instance.onTokenRefresh` → POST again.
- [ ] Logout: `DELETE /api/v1/app/devices/fcm-token`.
- [ ] Handle `notification` + `data`; stringify-safe parsing.
- [ ] Staging app → staging API base URL; prod app → prod API.

## Checklist for backend / DevOps (after receiving service account)

- [ ] Set `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON`, `FCM_SHARED_PROJECT_ENABLED=true`.
- [ ] Set `PROVIDER_MODE=live` in production.
- [ ] Run message **workers** alongside API.
- [ ] Confirm no per-tenant FCM override unless intentionally using a separate Firebase project.
- [ ] End-to-end test: login → register token → trigger notification → device receives push and inbox row.

---

## Message to copy to Flutter / Firebase owner

> We use **one Firebase project** for all jeweller customer apps and **one backend**. Please send us securely:
> 1) Firebase **project ID**, and  
> 2) **Service account JSON** (Admin SDK key) for that project — **not** `google-services.json` / plist.  
> Confirm every app flavor’s `project_id` in mobile config matches that project.  
> Confirm iOS APNs is uploaded in Firebase.  
> The app should call **`POST /api/v1/app/devices/fcm-token`** after login (fields: `fcmToken`, `deviceId`, `platform`) and **`DELETE`** the same path on logout. Full contract: `docs/FCM_CUSTOMER_APP_INTEGRATION.md` in the backend repo.
