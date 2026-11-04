# Flutter — PhonePe payment integration (SwarnaGrow)

**Audience:** Flutter customer app developers  
**Backend:** `/api/v1` customer app routes  
**Credentials:** Stored per jeweller in MongoDB (`tenant.integrationSecrets.phonepe`), configured via Platform → Payment gateway — **not** in server `.env`.

Platform `.env` only controls rollout (`PROVIDER_MODE`, `PHONEPE_ENV`, `PHONEPE_UPI_*`, ecommerce/digital-metals flags). See [PHONEPE_PRODUCTION_ACTIVATION_HANDOFF.md](./PHONEPE_PRODUCTION_ACTIVATION_HANDOFF.md).

---

## 1. Principles

1. **Never embed PhonePe client secrets in the Flutter app.** The backend creates orders with the tenant’s sealed credentials and returns a short-lived **SDK token**.
2. **Do not open the system browser** for checkout. Use the **PhonePe Payment SDK** (Android/iOS) with the token from the backend.
3. **Do not trust redirect URLs or deep links for success.** Poll the backend `statusPollUrl` until a terminal state; webhooks + reconcile jobs are authoritative.
4. **Reuse idempotency keys** when retrying the same user action after timeouts (same key + same body).

Recommended headers on every authenticated call:

```http
Authorization: Bearer <accessToken>
Content-Type: application/json
X-Idempotency-Key: <uuid-v4>
X-Platform: android
X-App-Version: 1.0.0
```

---

## 2. Unified checkout response shape

After initiating payment, normalize the `data` object:

| Field | Meaning |
|--------|---------|
| `checkoutKind` | `SDK_ORDER` (Flutter) or `HOSTED_REDIRECT` (web only) |
| `provider` | `PHONEPE` |
| `token` / `sdkToken` | Pass to PhonePe native SDK |
| `merchantOrderId` | PhonePe merchant order id (backend reference) |
| `providerOrderId` | PhonePe order id when present |
| `statusPollUrl` | Relative path — prefix with API base |
| `paymentUrl` | **Web only** — ignore on Flutter |

---

## 3. Scheme payments

### 3.1 Flexible scheme — SDK (recommended for Flutter)

```http
POST /api/v1/app/schemes/{schemeId}/pay/sdk-order
X-Idempotency-Key: flexible-sdk-01

{
  "amountPaise": 75000,
  "targetCycle": "2026-10",
  "expectedPositionVersion": 9,
  "redirectUrl": "https://your.app/payment-return",
  "mobile": "+919876543210"
}
```

`redirectUrl` must be an **https** URL whose origin is allowed (`CORS_ORIGINS` or tenant `branding.websiteUrl`). Use an app link domain you control (e.g. Firebase Dynamic Link landing page) if needed.

**Poll:**

```http
GET /api/v1/app/payment-intents/{intentId}
```

Terminal UI states: `PAID`, `FAILED`, `EXPIRED`, `CANCELLED`, `PROCESSING`.

### 3.2 Fixed scheme — SDK (Flutter)

Web uses payment link + public initiate; **Flutter should use SDK:**

```http
POST /api/v1/app/schemes/{schemeId}/pay/sdk-order
X-Idempotency-Key: fixed-sdk-01

{
  "amountPaise": 100000,
  "redirectUrl": "https://your.app/payment-return",
  "mobile": "+919876543210"
}
```

**Poll:**

```http
GET /api/v1/app/payments/{paymentLinkId}/status
```

Response uses `checkoutKind: "SDK_ORDER"` and `statusPollUrl: "/app/payments/{id}/status"`.

### 3.3 Enrolment with pay-now

`POST /app/schemes/enrol` may return `FLEXIBLE_PAYMENT_INTENT` (hosted redirect today) or `FIXED_PAYMENT_LINK`. For Flutter enrol + pay, prefer:

1. Enrol with `payNow: false`, then call `/pay/sdk-order`, **or**
2. Enrol with `payNow: true` and, if the response is hosted-only, immediately start a fresh `/pay/sdk-order` for the new scheme id (same amount / cycle rules).

---

## 4. Ecommerce (shop)

```http
POST /api/v1/app/shop/orders/{orderId}/payment-intents
X-Idempotency-Key: shop-pay-01

{
  "redirectUrl": "https://your.app/shop/orders/{orderId}",
  "idempotencyKey": "shop-pay-01"
}
```

**Poll:**

```http
GET /api/v1/app/shop/orders/{orderId}/payment-intents/{paymentAttemptId}
```

Requires tenant PhonePe + ecommerce rollout flags (see handoff doc).

---

## 5. Digital metals

**Buy:**

```http
POST /api/v1/app/digital-metals/buy-orders/{orderId}/payment-intents
```

**Redemption charge:**

```http
POST /api/v1/app/digital-metals/redemption/orders/{orderId}/payment-intents
```

Poll the `statusPollUrl` returned on the payment intent. Live checkout requires verified tenant PhonePe credentials (`DIGITAL_METALS_CHECKOUT_MODE=live` in non-production).

---

## 6. PhonePe native SDK (Flutter)

1. Add PhonePe’s official Flutter/Android/iOS SDK per [PhonePe Developer Portal](https://developer.phonepe.com/).
2. On `SDK_ORDER` response, read `token` (not `paymentUrl`).
3. Start checkout with:
   - **Token** from backend
   - **Merchant order id** from backend (`merchantOrderId`) for logging/support only
   - **Return URL** matching the `redirectUrl` you sent (app deep link handler)
4. When the SDK completes (success/failure/cancel), **still poll** `statusPollUrl` until `PAID` or terminal failure.

Do **not** load `https://mercury.phonepe.com/transact/pg?token=...` in an external browser on mobile — that path is for **web** clients only.

---

## 7. Polling guidelines

- Honor `retryAfterSeconds` from poll responses (typically 3s while `PROCESSING`).
- Cap client polling (e.g. 5–10 minutes); backend reconcile continues.
- Show “Payment received — verification pending” for `UNALLOCATED_PENDING_REVIEW` / `AMOUNT_MISMATCH_PENDING_REVIEW` — do not charge again.

---

## 8. Errors to handle

| Code | Action |
|------|--------|
| `PAYMENT_GATEWAY_NOT_CONFIGURED` | Jeweller has not saved PhonePe in platform settings |
| `PAYMENT_POSITION_CHANGED` | Re-fetch payable range / scheme detail, retry with new `expectedPositionVersion` |
| `PAYMENT_LINK_BUSY` | Wait and retry with same idempotency key |
| Provider 5xx on initiation | Retry same idempotency key + body |

---

## 9. Tenant setup checklist (ops)

1. Platform → tenant → **Payment gateway**: Client Id, Client Secret, Client Version, environment `SANDBOX` or `PRODUCTION`, webhook username/password.
2. PhonePe dashboard → webhook URL: `https://<api-host>/api/v1/webhooks/phonepe/<tenantId>`
3. **Verify** integration: `POST /api/v1/platform/tenants/:tenantId/integrations/payment-gateway/verify`
4. Enable `customerAppPaymentsEnabled` and product rollouts (schemes / ecommerce / digital metals).

---

## 10. Related docs

- [`docs/FLUTTER_CUSTOMER_API_GUIDE.md`](./FLUTTER_CUSTOMER_API_GUIDE.md) — **full customer portal API** (auth, schemes, shop, Digital Gold, §8 PhonePe)
- [`docs/FLUTTER_CUSTOMER_ECOMMERCE_AND_DIGITAL_METALS_INTEGRATION.md`](./FLUTTER_CUSTOMER_ECOMMERCE_AND_DIGITAL_METALS_INTEGRATION.md) — shop + Digital Gold example JSON for every route
- [PHONEPE_PRODUCTION_ACTIVATION_HANDOFF.md](./PHONEPE_PRODUCTION_ACTIVATION_HANDOFF.md) — gates, webhooks, reconcile
- [ECOMMERCE_PHONEPE_STAGING_CHECKLIST.md](./ECOMMERCE_PHONEPE_STAGING_CHECKLIST.md) — shop staging
