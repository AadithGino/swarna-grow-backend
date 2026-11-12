# Flutter customer: handover OTP, pickup code, Socket.IO drawer & support replies

**Audience:** Flutter customer app  
**API prefix:** `/api/v1`  
**Verified against backend commit:** `eec8ce3` (update when shipping)  
**Canonical copies:**  
- `swarnagrow-backend/docs/FLUTTER_CUSTOMER_HANDOVER_OTP_AND_SUPPORT.md`  
- `SwarnaGrow-Tenant-Admin/docs/FLUTTER_CUSTOMER_HANDOVER_OTP_AND_SUPPORT.md`

Related: [`FLUTTER_CUSTOMER_API_GUIDE.md`](./FLUTTER_CUSTOMER_API_GUIDE.md) (§13 grievances), [`FLUTTER_CUSTOMER_ECOMMERCE_AND_DIGITAL_METALS_INTEGRATION.md`](./FLUTTER_CUSTOMER_ECOMMERCE_AND_DIGITAL_METALS_INTEGRATION.md) (shop orders), `FCM_CUSTOMER_APP_INTEGRATION.md`.

---

## 1. What this covers

| Flow | Who starts it | What the customer sees |
|------|---------------|------------------------|
| **Scheme redemption handover OTP** | Store staff releases a 6-digit code for an **approved** redemption | Live socket + FCM → bottom sheet / drawer with code (reveal API) |
| **Shop branch-pickup code** | Staff releases / reissues pickup code on a **READY_FOR_PICKUP** order | Live socket + FCM → drawer with code (order detail `pickupCode`) |
| **Support ticket staff reply** | Tenant admin posts a **public** reply on a grievance | Customer must **refetch** ticket detail; show staff bubbles; ignore internal notes |

**Security rule:** Push and Socket.IO payloads **never include the plaintext 6-digit code**. The app must call a reveal / order endpoint after the event.

---

## 2. Socket.IO realtime (required for in-app drawer)

### Connect

| | |
|--|--|
| Origin | Same host as API (e.g. `https://api.example.com`) — **not** `/api/v1` |
| Path | `/realtime` |
| Auth | Customer **access** JWT only |
| Transports | `websocket`, then `polling` |

```dart
// Pseudocode — socket_io_client
io.io(
  apiOrigin, // e.g. https://api.example.com  (strip /api/v1)
  OptionBuilder()
    .setPath('/realtime')
    .setAuth({'token': accessToken})
    .setTransports(['websocket', 'polling'])
    .enableReconnection()
    .build(),
);
```

- Connect after successful customer login / token restore.
- On access-token refresh: update `auth.token` and reconnect if the socket dropped `UNAUTHENTICATED`.
- Disconnect on logout.
- Server joins room `customer:{tenantId}:{customerId}` from JWT claims `typ=CUSTOMER`, `tid`, `sub`.

### Events (server → client)

| Event name | When | Payload (no code) |
|------------|------|-------------------|
| `redemption.handover_otp_released` | Staff released / reissued redemption OTP | see below |
| `shop.pickup_code_released` | Staff released / reissued shop pickup code | see below |

**Redemption payload**

```json
{
  "kind": "REDEMPTION_OTP",
  "deepLink": "/schemes/redemptions/{redemptionId}/handover-otp",
  "expiresAt": "2026-11-11T18:45:00.000Z",
  "redemptionId": "rdm_...",
  "schemeId": "sch_..."
}
```

**Shop pickup payload**

```json
{
  "kind": "SHOP_PICKUP",
  "deepLink": "/shop/order/{orderId}",
  "expiresAt": "2026-11-13T18:00:00.000Z",
  "orderId": "eord_...",
  "orderNumber": "ORD-..."
}
```

### Drawer UX (match web customer portal)

1. On either socket event → open a **modal / bottom sheet** immediately (optional toast).
2. Call the reveal / order API (below) to load the 6-digit code.
3. Show large monospace digits + “Valid until …” from `expiresAt`.
4. Copy: “Show this code at the store. Do not share online.”
5. Cold start / FCM tap: navigate via `deepLink` and open the same drawer / order screen.

Socket is **best-effort**. Always support FCM deep link + pull-to-refresh as fallbacks.

---

## 3. Scheme redemption handover OTP

### Staff side (context only)

- Admin: `POST /admin/redemptions/{redemptionId}/release-handover-otp`
- Completing redemption requires staff to enter the customer-shown code (`handoverOtp`).
- OTP TTL: **30 minutes**. Max failed attempts: **5** (then staff must reissue).

### Customer: reveal code

```http
GET /api/v1/app/redemptions/{redemptionId}/handover-otp
Authorization: Bearer <customerAccessToken>
```

**Success `data` (shape)**

```json
{
  "redemptionId": "rdm_...",
  "schemeId": "sch_...",
  "handoverOtp": "482910",
  "expiresAt": "2026-11-11T18:45:00.000Z",
  "handoverOtpActive": true,
  "handoverOtpExpiresAt": "2026-11-11T18:45:00.000Z",
  "handoverOtpFailedAttempts": 0,
  "handoverOtpReleasedAt": "2026-11-11T18:15:00.000Z",
  "handoverOtpMaxAttempts": 5
}
```

**Errors to handle**

| `error.code` | Meaning | UI |
|--------------|---------|-----|
| `REDEMPTION_OTP_NOT_ACTIVE` | No active sealed code / expired | “Ask store staff to release a code” |
| `REDEMPTION_STATUS_INVALID` | Not `APPROVED` | Hide OTP UI |
| `404` | Wrong id / not this customer | Go back |

### FCM

| Field | Value |
|-------|--------|
| `messageType` / type | `SCHEME_REDEMPTION_HANDOVER_OTP` |
| Title / body | “Redemption code ready” (no digits) |
| `deepLink` | `/schemes/redemptions/{redemptionId}/handover-otp` |

On tap → open handover drawer and `GET .../handover-otp`.

---

## 4. Shop branch pickup code

### Staff side (context)

- Admin releases/reissues: ecommerce order pickup-code endpoint (tenant admin UI: “Release / reissue pickup code”).
- Staff enter the code the customer shows; plaintext is **not** returned to staff.
- Pickup code TTL: **48 hours**.

### Customer: load code

There is **no separate reveal route**. After socket/FCM:

```http
GET /api/v1/app/shop/orders/{orderId}
Authorization: Bearer <customerAccessToken>
```

When status is `READY_FOR_PICKUP` and a code is active, `data` includes:

```json
{
  "id": "eord_...",
  "orderNumber": "ORD-...",
  "status": "READY_FOR_PICKUP",
  "pickupCode": "739104",
  "fulfilmentHandover": {
    "pickupCodeExpiresAt": "2026-11-13T18:00:00.000Z",
    "pickupCodeActive": true
  }
}
```

If `pickupCode` is `null`, show “Ask the store to release the code again.”

### FCM

| Field | Value |
|-------|--------|
| Type | `ECOMMERCE_PICKUP_CODE_RELEASED` |
| `deepLink` | `/shop/order/{orderId}` |

On tap → order detail (code section) and/or the same global drawer.

### Order screen (always)

Even without socket: when `READY_FOR_PICKUP` and `pickupCode` is present, show the large “Show this code at the store” block on the order page.

---

## 5. Recommended Flutter architecture

```
CustomerSession
  ├─ SocketClient (/realtime + access token)
  │    ├─ on redemption.handover_otp_released → HandoverDrawerController.openRedemption(id)
  │    └─ on shop.pickup_code_released → HandoverDrawerController.openPickup(orderId)
  ├─ FcmHandler
  │    ├─ SCHEME_REDEMPTION_HANDOVER_OTP → same as socket (deepLink)
  │    └─ ECOMMERCE_PICKUP_CODE_RELEASED → order / drawer
  └─ HandoverDrawer (overlay)
       ├─ GET /app/redemptions/:id/handover-otp
       └─ GET /app/shop/orders/:id  → pickupCode
```

Keep the drawer **global** (above bottom nav) so it works from Home / Shop / Schemes.

---

## 6. Support tickets — staff replies visible to the customer

### APIs

```http
GET  /api/v1/app/grievances
GET  /api/v1/app/grievances/{grievanceId}
POST /api/v1/app/grievances/{grievanceId}/messages
X-Idempotency-Key: ...
{ "body": "...", "expectedVersion": 2 }

POST /api/v1/app/grievances/{grievanceId}/reopen
X-Idempotency-Key: ...
{ "reason": "...", "expectedVersion": 3 }
```

### Message model (customer detail)

Each message in `data.messages`:

```json
{
  "_id": "gvm_...",
  "type": "PUBLIC_REPLY",
  "messageType": "PUBLIC_REPLY",
  "actorType": "USER",
  "body": "We found your payment on file…",
  "createdAt": "2026-11-11T10:00:00.000Z",
  "author": { "actorType": "USER", "name": "Divya Admin" }
}
```

| `author.actorType` / `actorType` | UI |
|----------------------------------|-----|
| `CUSTOMER` | Outgoing bubble (customer) |
| `USER` | Incoming bubble (jeweller support) |

### Critical rules

1. **Only `PUBLIC_REPLY` is customer-visible.**  
   Backend filters out `INTERNAL_NOTE` and `SYSTEM_EVENT` on customer `GET`. Still ignore those client-side if present.
2. **Staff “Internal note” in admin never appears in the app.** Admins must use **Customer reply** / public reply for the customer to see text.
3. **There is no Socket.IO event for grievance replies today.**  
   After staff replies, status often moves toward `WAITING_FOR_CUSTOMER` (“Awaiting your reply”).
4. **Always refetch** ticket list + detail:
   - on screen open / resume
   - on pull-to-refresh
   - while detail is open, poll every ~15s (optional but recommended)
5. Send customer replies with current `expectedVersion`; on `409 VERSION_CONFLICT`, refetch and retry.
6. List rows may omit full `messages` — always load **detail** for the thread.

### Status labels (customer)

| API `status` | Suggested label |
|--------------|-----------------|
| `OPEN` | Open |
| `IN_PROGRESS` | In progress |
| `WAITING_FOR_CUSTOMER` | Awaiting your reply |
| `RESOLVED` | Resolved |
| `CLOSED` | Closed |

Allow customer reply when status is `OPEN` / `IN_PROGRESS` / `WAITING_FOR_CUSTOMER` (or when `allowedActions` includes `REPLY` if provided).

### Deep links

Prefer `/support/{grievanceId}` (or your existing support route). Inbox type `GRIEVANCE` may appear for older notification templates; handover/pickup use the types in §3–4.

---

## 7. Checklist for Flutter QA

- [ ] Socket connects with customer access token; reconnects after refresh
- [ ] Staff releases redemption OTP → drawer opens without killing the app → 6 digits from reveal API
- [ ] Push tap for `SCHEME_REDEMPTION_HANDOVER_OTP` opens same drawer
- [ ] Code never appears in FCM body / socket payload (inspect logs)
- [ ] Expired OTP shows friendly error; reissue works
- [ ] Staff releases shop pickup code → drawer / order shows `pickupCode`
- [ ] Order page shows code when `READY_FOR_PICKUP` without relying on socket
- [ ] Admin **public** reply appears after refetch/poll; **internal note** does not
- [ ] `WAITING_FOR_CUSTOMER` badge after staff public reply
- [ ] Customer reply bumps version; conflict path refetches

---

## 8. Endpoint index (this feature set)

| Method | Path | Notes |
|--------|------|--------|
| GET | `/app/redemptions/{redemptionId}/handover-otp` | Reveal scheme handover OTP |
| GET | `/app/shop/orders/{orderId}` | Includes `pickupCode` when active |
| GET | `/app/grievances` | List |
| GET | `/app/grievances/{id}` | Thread (`PUBLIC_REPLY` only) |
| POST | `/app/grievances/{id}/messages` | Customer reply (idempotent) |
| POST | `/app/grievances/{id}/reopen` | Within reopen window |
| WS | `path=/realtime` | Events in §2 |

Admin-only (not for Flutter customer): release OTP / release pickup code.
