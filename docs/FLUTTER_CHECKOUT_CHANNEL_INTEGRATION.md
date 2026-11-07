# Flutter — SDK vs hosted PhonePe (headers, payloads, responses)

**Audience:** Flutter dev implementing customer payments  
**API base:** `{API_BASE}/api/v1` (e.g. `https://swarnagrow-backend.vercel.app/api/v1`)  
**Envelope:** Every response is `{ "success": true, "data": ... }` or `{ "success": false, "error": { "code", "message", "details" } }`.

---

## 1. How the backend chooses SDK vs web (no magic body field)

The **JSON body does not contain** a switch like `"mode": "sdk"`. Routing is driven by:

1. **Which URL** you call (some routes are SDK-only; see §4).
2. **Headers** `X-Platform` and optional `X-Checkout-Channel`.
3. **Body `redirectUrl`** — required on most flows that actually hit PhonePe (allowed https origin per tenant / CORS).

Rough rule on **payment-intent style** routes:

| `X-Checkout-Channel` | Meaning |
|---------------------|---------|
| omit or `auto` | `X-Platform: android` or `ios` → **SDK** (`checkoutKind: SDK_ORDER`, token). No / other platform → **hosted** (`checkoutKind: HOSTED_REDIRECT`, browser URL). |
| `sdk` | Always SDK. |
| `hosted` | Always hosted (use WebView or system browser + redirect). |

Invalid value → **400** `VALIDATION_FAILED`, `error.details[0].field` = `x-checkout-channel`.

**Dedicated SDK routes** (e.g. `POST /app/schemes/{id}/pay/sdk-order`) **always** create an SDK order; `X-Checkout-Channel` does not turn them into hosted.

---

## 2. Headers to send on every mutation

Use a shared `Map<String, String>` (or `dio` `Options`) for payment calls:

```http
Authorization: Bearer <access_token>
Content-Type: application/json
X-Idempotency-Key: <uuid-v4>          # required on idempotent POSTs — reuse on retry
X-Platform: android                   # or ios — for auto → SDK on payment-intent routes
X-Checkout-Channel: auto               # optional: auto | sdk | hosted
X-App-Version: 1.2.0                  # recommended
```

- **Native app (PhonePe SDK):** set `X-Platform: android`/`ios`, omit channel or use `auto`, or force `X-Checkout-Channel: sdk`.
- **Hosted in WebView (bridge):** set `X-Checkout-Channel: hosted` (platform header optional; hosted wins).
- **Force browser checkout on device:** `X-Checkout-Channel: hosted` + body `redirectUrl` to your return page.

---

## 3. How to read the response (one decision)

After **201** success, read `data` (often a **payment intent** object or nested `paymentIntent`).

1. **`checkoutKind`**  
   - `"SDK_ORDER"` → use **`token` / `sdkToken`** with **PhonePe native SDK** (do not rely on browser URL for success).  
   - `"HOSTED_REDIRECT"` → open **`paymentUrl`** (same as **`gatewayUrl`**) in **WebView or browser**.

2. **Always poll** **`statusPollUrl`** until status is terminal (PAID / FAILED / CANCELLED / etc.). Do not trust redirect alone.

3. **`paymentUrl` / `gatewayUrl`:**  
   - Hosted: **PhonePe** hosted page.  
   - SDK: may be a **gateway helper URL** derived from token — **prefer native SDK** with `token` when `checkoutKind === SDK_ORDER`.

---

## 4. Endpoints, body JSON, and example responses

Replace `{schemeId}`, `{orderId}`, `{paymentAttemptId}` with real ids.

### 4.1 Flexible scheme — payment intent (auto / sdk / hosted)

**POST** `/app/schemes/{schemeId}/payment-intents`

**Body** (Zod `paymentIntentBody` — extra keys are rejected):

```json
{
  "amountPaise": 75000,
  "targetCycle": "2026-11",
  "expectedPositionVersion": 9,
  "redirectUrl": "https://yourapp.com/pay-return",
  "mobile": "+919876543210"
}
```

- `redirectUrl` — use an **https** URL with origin allowed for the jeweller (and typical CORS rules). Same URL used by PhonePe after hosted pay.
- `targetCycle` / `expectedPositionVersion` — from latest **payable-range** call (see main Flutter guide).

**Example — SDK path** (headers: `X-Platform: android`, channel omit or `auto`):

```json
{
  "success": true,
  "data": {
    "checkoutKind": "SDK_ORDER",
    "provider": "PHONEPE",
    "intentId": "intent_01HQ…",
    "id": "intent_01HQ…",
    "schemeId": "scheme_01…",
    "targetCycle": "2026-11",
    "amount": { "amountPaise": 75000, "amountDisplay": "₹750" },
    "status": "PENDING",
    "positionVersion": 9,
    "token": "phonepe-sdk-token",
    "sdkToken": "phonepe-sdk-token",
    "merchantOrderId": "intent_01HQ…",
    "providerOrderId": "OMO…",
    "paymentUrl": "https://merchant.phonepe.com/…",
    "gatewayUrl": "https://merchant.phonepe.com/…",
    "statusPollUrl": "/app/payment-intents/intent_01HQ…",
    "retryAfterSeconds": 3,
    "paymentId": "pay_01…"
  }
}
```

**Example — hosted path** (`X-Checkout-Channel: hosted` or web with no mobile platform):

```json
{
  "success": true,
  "data": {
    "checkoutKind": "HOSTED_REDIRECT",
    "provider": "PHONEPE",
    "intentId": "intent_01HQ…",
    "paymentUrl": "https://mercury-uat.phonepe.com/…",
    "gatewayUrl": "https://mercury-uat.phonepe.com/…",
    "token": null,
    "sdkToken": null,
    "statusPollUrl": "/app/payment-intents/intent_01HQ…",
    "retryAfterSeconds": 3
  }
}
```

**Poll:** `GET {API_BASE}/api/v1` + `data.statusPollUrl`  
Example: `GET /api/v1/app/payment-intents/intent_01HQ…`

---

### 4.2 Flexible scheme — SDK-only route

**POST** `/app/schemes/{schemeId}/pay/sdk-order`

Same **body** shape as §4.1. Response shape matches **`paymentIntentAppDto`** like §4.1 (expects **`SDK_ORDER`** + token). `redirectUrl` is **required** by the server for SDK order creation.

---

### 4.3 Shop (ecommerce) order payment

**POST** `/app/shop/orders/{orderId}/payment-intents`

**Body:**

```json
{
  "redirectUrl": "https://yourapp.com/shop/orders/order_123"
}
```

**Response:** use `data.paymentIntent` (or top-level fields depending on controller) — same idea: `checkoutKind`, `token` / `paymentUrl`, `statusPollUrl`. Poll the returned **`statusPollUrl`**.

---

### 4.4 Digital Gold — buy order payment

**POST** `/app/digital-metals/buy-orders/{orderId}/payment-intents`

**Body:**

```json
{
  "redirectUrl": "https://yourapp.com/digital-metals/buy-return"
}
```

**Response envelope:**

```json
{
  "success": true,
  "data": {
    "paymentIntent": {
      "id": "dmattempt_…",
      "orderId": "dmbuy_…",
      "status": "INITIATED",
      "amountPaise": 606000,
      "currency": "INR",
      "checkoutKind": "SDK_ORDER",
      "provider": "PHONEPE",
      "token": "…",
      "sdkToken": "…",
      "paymentUrl": "…",
      "gatewayUrl": "…",
      "statusPollUrl": "/app/digital-metals/buy-orders/dmbuy_…/payment-intents/dmattempt_…",
      "providerOrderId": "…",
      "merchantOrderId": "…"
    },
    "order": { }
  }
}
```

For **hosted**, `checkoutKind` is `HOSTED_REDIRECT`, `paymentUrl` is the PhonePe page, `token`/`sdkToken` may be null.

**Poll:** `GET` `{API_BASE}/api/v1` + `paymentIntent.statusPollUrl`

---

### 4.5 Digital Gold — redemption charge payment

**POST** `/app/digital-metals/redemption/orders/{orderId}/payment-intents`

**Body:** same as buy — `{ "redirectUrl": "https://…" }` (strict).

**Response:** same pattern: `data.paymentIntent` + `checkoutKind` / `token` / `paymentUrl` / `statusPollUrl`.

**Poll:** `GET` full URL from `paymentIntent.statusPollUrl`.

---

## 5. Flutter client flow (minimal pseudocode)

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';

const apiBase = 'https://swarnagrow-backend.vercel.app/api/v1';
final uuid = const Uuid();

Future<void> payFlexibleScheme({
  required String accessToken,
  required String schemeId,
  required int amountPaise,
  required String targetCycle,
  required int expectedPositionVersion,
  required String redirectUrl,
}) async {
  final idempotencyKey = uuid.v4();
  final uri = Uri.parse('$apiBase/app/schemes/$schemeId/payment-intents');
  final res = await http.post(
    uri,
    headers: {
      'Authorization': 'Bearer $accessToken',
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
      'X-Platform': 'android',
      'X-Checkout-Channel': 'auto',
    },
    body: jsonEncode({
      'amountPaise': amountPaise,
      'targetCycle': targetCycle,
      'expectedPositionVersion': expectedPositionVersion,
      'redirectUrl': redirectUrl,
    }),
  );
  final body = jsonDecode(res.body) as Map<String, dynamic>;
  if (body['success'] != true) {
    throw Exception(body['error']);
  }
  final data = body['data'] as Map<String, dynamic>;
  final kind = data['checkoutKind'] as String?;
  final pollPath = data['statusPollUrl'] as String;

  if (kind == 'SDK_ORDER') {
    final token = data['token'] as String? ?? data['sdkToken'] as String?;
    // 1) Pass token to PhonePe Flutter SDK and start checkout
    // 2) Poll:
    await pollStatus(accessToken, pollPath);
  } else if (kind == 'HOSTED_REDIRECT') {
    final url = data['paymentUrl'] as String? ?? data['gatewayUrl'] as String?;
    // 1) Open url in WebView / external browser; user completes PhonePe
    // 2) User lands on redirectUrl — show “Processing…” and poll:
    await pollStatus(accessToken, pollPath);
  }
}

Future<void> pollStatus(String accessToken, String statusPollRelativePath) async {
  final uri = Uri.parse('$apiBase$statusPollRelativePath');
  while (true) {
    final r = await http.get(uri, headers: {
      'Authorization': 'Bearer $accessToken',
      'Accept': 'application/json',
    });
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    if (j['success'] != true) break;
    final data = j['data'];
    // Read terminal payment/intent status from `data` shape for that endpoint
    await Future<void>.delayed(const Duration(seconds: 3));
  }
}
```

Adjust parsing for **digital metals** where the intent is under **`data.paymentIntent`**.

---

## 6. “Enter UPI ID” (VPA) on hosted / WebView

The **Pay with UPI ID** field is PhonePe’s **COLLECT** flow. For **hosted** `createPayment`, the backend now asks PhonePe’s standard checkout for **UPI flows INTENT + COLLECT + QR** so WebView and mobile browser are more likely to show **VPA entry** next to app intents. If PhonePe rejects that mode pack for the merchant, we **fall back** to the previous unrestricted `pay()` request.

If VPA still never appears, check **merchant/UAT** settings with PhonePe, and open **`paymentUrl`** in **Custom Tabs / SFSafariViewController** instead of a plain WebView where possible.

---

## 7. Common mistakes

- Sending **extra JSON keys** on strict bodies (e.g. digital metals only allows `redirectUrl`) → validation error.
- Omitting **`X-Idempotency-Key`** on POSTs that require it → 400 / route error.
- Using **`redirectUrl` not allowed** for the tenant → `VALIDATION_FAILED` on `redirectUrl`.
- Treating **SDK** responses like **hosted** (opening `paymentUrl` in browser instead of native SDK when `checkoutKind === SDK_ORDER`).

---

## 8. Related docs

- `docs/FLUTTER_CUSTOMER_API_GUIDE.md` — full API surface
- `docs/FLUTTER_PHONEPE_INTEGRATION.md` — PhonePe checklist + §1.1 headers
- `docs/HANDOFF_X_CHECKOUT_CHANNEL_2026-11-06.md` — deploy URLs + summary
