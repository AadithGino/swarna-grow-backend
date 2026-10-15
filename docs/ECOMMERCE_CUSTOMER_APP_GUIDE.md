# Ecommerce module — customer app API (`/app/shop/*`)

**Base URL:** `{API_BASE}/api/v1`  
**Auth:** Customer JWT — `Authorization: Bearer <accessToken>`  
**Verified backend commit:** `b84f3b327fc75c31a3ba33c8e586debb1eee7921` (`ecommerce` branch)

Companion docs: [ECOMMERCE_API_CONTRACT.md](./ECOMMERCE_API_CONTRACT.md) (admin + edge cases), [FLUTTER_CUSTOMER_API_GUIDE.md](./FLUTTER_CUSTOMER_API_GUIDE.md) (full customer app), [ECOMMERCE_PROMOTION_FCM.md](./ECOMMERCE_PROMOTION_FCM.md) (admin pushes + gold-rate campaigns).

---

## Conventions

| Topic | Rule |
|-------|------|
| Money | Integer **paise** in requests; responses often include `moneyRef` objects `{ amountPaise, amountRupees, amountDisplay }` on catalog `pricing`. |
| Gold weight | Integer **mg** on products (`goldWeightMg`). |
| Idempotency | Required on: `PUT /shop/cart`, `POST /shop/quotes`, `POST /shop/orders`, `POST /shop/orders/:id/payment-intents`, address create, cancel/return/cancellation requests. Header: `X-Idempotency-Key` (8–128 chars). |
| Strict bodies | Undocumented JSON keys → `400 VALIDATION_FAILED`. |
| Store gate | Most shop routes call `assertEcommerceOperational` → `403 ECOMMERCE_NOT_AVAILABLE` when plan/store off. **`GET /shop/availability`** always works. |

### Enums (customer-facing)

| Enum | Values |
|------|--------|
| `EcommerceFulfilmentMode` | `BRANCH_PICKUP`, `DELIVERY` |
| `EcommercePaymentMethod` | `ONLINE` (PhonePe when payments enabled), `COD` |
| `EcommerceQuoteStatus` | `ACTIVE`, `EXPIRED`, `CONSUMED`, `CANCELLED` |
| `EcommerceOrderStatus` | `PENDING_PAYMENT`, `PAYMENT_EXPIRED`, `PAYMENT_FAILED`, `COD_PENDING_ACCEPTANCE`, `PAID`, `PROCESSING`, `READY_FOR_PICKUP`, `SHIPPED`, `DELIVERED`, `CANCELLED`, `REFUND_PENDING`, `REFUNDED` |
| `EcommercePriceMode` | `FIXED`, `GOLD_RATE_BASED` |
| `EcommerceStockPolicy` | `QUANTITY_TRACKED`, `MADE_TO_ORDER` |

---

## 1. Store availability (gate UI)

### `GET /app/shop/availability`

No idempotency. Callable even when store is off.

**Response `200`**

```json
{
  "success": true,
  "data": {
    "available": true,
    "ecommerce": {
      "planEntitled": true,
      "enabled": true,
      "active": true,
      "hasOrderHistory": false
    },
    "hasOrderHistory": false,
    "orderHistoryAvailable": false
  }
}
```

When `available: false`, hide shop checkout; you may still show order history if `hasOrderHistory`.

---

## 2. Promotional banners

### `GET /app/home/banners`

Plan ecommerce entitlement; **HOME** / **BOTH** placements.

### `GET /app/shop/banners`

Operational store; **SHOP** / **BOTH** placements.

**Response `200`**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "ebnr_01JABC",
        "title": "Festive edit",
        "subtitle": "22K highlights",
        "imageUploadId": "upload_01XYZ",
        "imageUrl": "/uploads/upload_01XYZ",
        "displayOrder": 0,
        "startsAt": "2026-01-20T04:30:00.000Z",
        "endsAt": null,
        "destination": {
          "type": "PRODUCT",
          "productId": "eprd_01RING",
          "slug": "gold-ring-22k"
        }
      }
    ],
    "meta": {
      "nextVisibilityChangeAt": "2026-01-20T04:30:00.000Z",
      "serverTime": "2026-01-01T12:00:00.000Z"
    }
  }
}
```

**Destination types:** `NONE`, `HOME`, `SHOP`, `SCHEMES`, `ORDERS` (requires order history), `CATEGORY` (`categoryId`), `PRODUCT` (`productId`, `slug`).

---

## 3. Store policies

### `GET /app/shop/store-policies`

**Response when published**

```json
{
  "success": true,
  "data": {
    "published": true,
    "policies": {
      "version": 2,
      "publishedAt": "2026-03-01T10:00:00.000Z",
      "shippingPolicyText": "…",
      "returnsPolicyText": "…",
      "cancellationPolicyText": "…",
      "refundContactPolicyText": "…",
      "returnEligibilityDays": 7
    }
  }
}
```

**When not ready:** `{ "published": false, "policies": null }` — checkout remains blocked server-side until admin approves all four policy texts.

---

## 4. Catalog

### `GET /app/shop/categories`

**Response**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "ecat_01",
        "name": "Rings",
        "slug": "rings",
        "description": "",
        "imageUploadId": "upload_cat",
        "imageUrl": "/uploads/upload_cat",
        "displayOrder": 0,
        "active": true,
        "version": 1,
        "updatedAt": "2026-02-01T08:00:00.000Z"
      }
    ]
  }
}
```

### `GET /app/shop/products`

**Query:** `limit`, `cursor`, `categoryId`, `featured=true`, `q` (≥2 chars), `sort=newest|name`.

**Response (paginated)**

```json
{
  "success": true,
  "data": [
    {
      "id": "eprd_01RING",
      "name": "Classic 22K Ring",
      "slug": "classic-22k-ring",
      "sku": "RNG-22-001",
      "description": "Handcrafted ring",
      "categoryId": "ecat_01",
      "imageUploadIds": ["upload_p1"],
      "imageUrls": [{ "uploadId": "upload_p1", "viewUrl": "/uploads/upload_p1" }],
      "featured": true,
      "status": "PUBLISHED",
      "purity": "22K",
      "goldWeightMg": 4200,
      "makingChargeMode": "PER_GRAM_PAISE",
      "makingCharge": { "perGramPaise": 80000 },
      "stones": [],
      "stoneChargePaise": null,
      "otherChargesPaise": 50000,
      "priceMode": "GOLD_RATE_BASED",
      "fixedPricing": null,
      "offer": null,
      "taxClassification": "JEWELLERY_22K",
      "version": 3,
      "updatedAt": "2026-03-10T06:00:00.000Z",
      "pricing": {
        "computable": true,
        "preTaxSubtotalPaise": 3104120,
        "displayTotalPaise": 3195344,
        "preTaxSubtotal": { "amountPaise": 3104120, "amountRupees": 31041.2, "amountDisplay": "₹31,041.20" },
        "displayTotal": { "amountPaise": 3195344, "amountRupees": 31953.44, "amountDisplay": "₹31,953.44" },
        "gold": {
          "goldValuePaise": 2730000,
          "ratePerGramPaise": 650000,
          "goldValue": { "amountPaise": 2730000, "amountDisplay": "₹27,300.00" },
          "ratePerGram": { "amountPaise": 650000, "amountDisplay": "₹6,500.00" }
        },
        "making": {
          "beforeOfferPaise": 336000,
          "offerDiscountPaise": 0,
          "afterOfferPaise": 336000
        },
        "tax": { "totalPaise": 91224, "lines": [] }
      },
      "availability": {
        "stockPolicy": "MADE_TO_ORDER",
        "availableQuantity": null,
        "purchasable": true,
        "label": "Made to order"
      }
    }
  ],
  "meta": {
    "limit": 20,
    "nextCursor": "eprd_01NEXT",
    "hasMore": true
  }
}
```

**Rules:** Display `pricing.displayTotal` only; never recompute gold-rate products locally. If `pricing.computable: false`, show blockers from admin/support — do not checkout.

### `GET /app/shop/products/{productIdOrSlug}`

Same product shape as list item (single object in `data`).

---

## 5. Saved addresses

### `GET /app/shop/addresses`

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "eaddr_01",
        "label": "Home",
        "recipientName": "Anu Joseph",
        "mobile": "+919876543210",
        "line1": "Rose Villa",
        "line2": "",
        "city": "Kochi",
        "state": "Kerala",
        "pincode": "682001",
        "isDefault": true,
        "version": 1
      }
    ]
  }
}
```

### `POST /app/shop/addresses`

**Headers:** `X-Idempotency-Key`

**Request**

```json
{
  "label": "Home",
  "recipientName": "Anu Joseph",
  "mobile": "+919876543210",
  "line1": "Rose Villa",
  "line2": "Near temple",
  "city": "Kochi",
  "state": "Kerala",
  "pincode": "682001",
  "isDefault": true
}
```

**Response `201`:** single address object (same fields as list item).

### `PATCH /app/shop/addresses/{addressId}`

**Request**

```json
{
  "expectedVersion": 1,
  "pincode": "682016"
}
```

---

## 6. Cart

### `GET /app/shop/cart`

```json
{
  "success": true,
  "data": {
    "id": "ecart_01",
    "checkoutUsable": false,
    "lines": [
      {
        "productId": "eprd_01RING",
        "quantity": 1,
        "product": {
          "id": "eprd_01RING",
          "name": "Classic 22K Ring",
          "slug": "classic-22k-ring",
          "status": "PUBLISHED"
        },
        "availability": {
          "stockPolicy": "MADE_TO_ORDER",
          "availableQuantity": null,
          "purchasable": true,
          "label": "Made to order"
        }
      }
    ],
    "version": 2
  }
}
```

### `PUT /app/shop/cart`

**Headers:** `X-Idempotency-Key`

**Request**

```json
{
  "expectedVersion": 2,
  "lines": [
    { "productId": "eprd_01RING", "quantity": 1 }
  ]
}
```

**Response `200`:** updated cart (same shape as GET). Unpublished products are dropped silently. `409 VERSION_CONFLICT` if `expectedVersion` stale.

---

## 7. Fulfilment options

### `GET /app/shop/fulfilment-options`

```json
{
  "success": true,
  "data": {
    "pickup": {
      "enabled": true,
      "branches": [
        { "id": "branch_01", "name": "Main Branch", "code": "HO" }
      ]
    },
    "delivery": {
      "enabled": true,
      "serviceablePincodes": ["682001", "682016"],
      "deliveryChargePaise": 15000,
      "supportedDestinationStates": ["Kerala"],
      "codEnabled": true,
      "codPincodes": ["682001"]
    },
    "checkoutUsable": false,
    "checkoutReadiness": {
      "ready": true,
      "blockers": []
    }
  }
}
```

Use this to build pickup vs delivery UI and COD eligibility by pincode.

---

## 8. Price quote (checkout snapshot)

Quotes lock prices, tax components, stock reservations (tracked SKUs), and expire after TTL (~minutes).

### `POST /app/shop/quotes`

**Headers:** `X-Idempotency-Key` (**required**)

**Pickup + online payment**

```json
{
  "fulfilmentMode": "BRANCH_PICKUP",
  "pickupBranchId": "branch_01",
  "paymentMethod": "ONLINE"
}
```

**Delivery + COD**

```json
{
  "fulfilmentMode": "DELIVERY",
  "addressId": "eaddr_01",
  "paymentMethod": "COD"
}
```

**Response `201`** (wrapper: `data` is the quote object)

```json
{
  "success": true,
  "data": {
    "id": "equote_01",
    "status": "ACTIVE",
    "lines": [
      {
        "productId": "eprd_01RING",
        "productVersion": 3,
        "name": "Classic 22K Ring",
        "sku": "RNG-22-001",
        "quantity": 1,
        "unitPricePaise": 3104120,
        "lineTotalPaise": 3104120,
        "pricingSnapshot": {
          "stockPolicy": "MADE_TO_ORDER",
          "estimate": { "computable": true, "preTaxSubtotalPaise": 3104120 },
          "rateRow": {
            "id": "egrt_01",
            "purity": "22K",
            "ratePerGramPaise": 650000,
            "effectiveAt": "2026-03-15T09:00:00.000Z",
            "version": 1
          }
        }
      }
    ],
    "fulfilmentMode": "BRANCH_PICKUP",
    "pickupBranchId": "branch_01",
    "addressSnapshot": null,
    "fulfilmentChargePaise": 0,
    "subtotalPaise": 3104120,
    "taxPaise": 91224,
    "totalPaise": 3195344,
    "taxComponentLines": [
      { "componentKey": "CGST", "label": "CGST", "rateBps": 150 }
    ],
    "financialSnapshot": {
      "subtotalPaise": 3104120,
      "taxPaise": 91224,
      "fulfilmentChargePaise": 0,
      "totalPaise": 3195344,
      "paymentMethod": "ONLINE",
      "quotedAt": "2026-03-15T10:05:00.000Z"
    },
    "expiresAt": "2026-03-15T10:20:00.000Z",
    "version": 1,
    "paymentMethod": "ONLINE",
    "codPincodeSnapshot": null,
    "paymentAllowed": true,
    "orderPlacementAllowed": true,
    "paymentMethods": {
      "online": { "allowed": true },
      "cod": { "allowed": false, "blockers": [] }
    },
    "checkoutUsable": true,
    "checkoutTaxReady": true,
    "previewOnly": false,
    "blockers": [],
    "testPaymentHarness": null
  }
}
```

When payments are disabled in staging, `paymentAllowed: false`, `previewOnly: true` — quote is for display only.

**Common errors:** `422 CHECKOUT_NOT_READY`, `422 INSUFFICIENT_STOCK`, `422 FULFILMENT_UNAVAILABLE`, `422 PRICE_NOT_COMPUTABLE`, empty cart.

### `GET /app/shop/quotes/{quoteId}`

Returns current quote (may be `EXPIRED`).

### `POST /app/shop/quotes/{quoteId}/cancel`

**Headers:** `X-Idempotency-Key`

---

## 9. Place order

### `POST /app/shop/orders`

**Headers:** `X-Idempotency-Key` (**required**)

**Request**

```json
{
  "quoteId": "equote_01"
}
```

**Response `201` — online order awaiting PhonePe**

```json
{
  "success": true,
  "data": {
    "id": "eord_01",
    "orderNumber": "SG-2026-00042",
    "status": "PENDING_PAYMENT",
    "statusLabel": "Awaiting payment — not charged",
    "paymentMethod": "ONLINE",
    "paymentAllowed": true,
    "paymentCompleted": false,
    "checkoutUsable": true,
    "quoteId": "equote_01",
    "lines": [],
    "fulfilmentMode": "BRANCH_PICKUP",
    "pickupBranchId": "branch_01",
    "subtotalPaise": 3104120,
    "taxPaise": 91224,
    "fulfilmentChargePaise": 0,
    "totalPaise": 3195344,
    "expiresAt": "2026-03-15T10:35:00.000Z",
    "version": 1,
    "refundStatus": "NONE",
    "activePaymentAttempt": null,
    "invoiceAvailable": false,
    "deliveryTracking": null,
    "storePolicySnapshot": { "version": 2 }
  }
}
```

**COD order:** `status: "COD_PENDING_ACCEPTANCE"`, `paymentMethod: "COD"`, `paymentAllowed: false`, jeweller must accept before fulfilment proceeds.

Re-use same idempotency key + body to recover from network failures (`created: false` on replay).

---

## 10. Online payment (PhonePe)

### `POST /app/shop/orders/{orderId}/payment-intents`

**Headers:** `X-Idempotency-Key` (**required**)

**Request**

```json
{
  "redirectUrl": "myapp://shop/payment-return"
}
```

**Response `201`**

```json
{
  "success": true,
  "data": {
    "id": "epay_01",
    "orderId": "eord_01",
    "status": "INITIATED",
    "amountPaise": 3195344,
    "currency": "INR",
    "providerOrderId": "PHONEPE-ORDER-xyz",
    "merchantOrderId": "epay_01",
    "token": "phonepe-sdk-or-intent-token",
    "redirectUrl": "myapp://shop/payment-return",
    "orderStatus": "PENDING_PAYMENT",
    "paymentAllowed": true,
    "paymentCompleted": false,
    "statusPollUrl": "/app/shop/orders/eord_01/payment-intents/epay_01",
    "failureReason": null,
    "operationalStatus": null
  }
}
```

Open PhonePe with `token` / redirect per your integration. Poll:

### `GET /app/shop/orders/{orderId}/payment-intents/{paymentAttemptId}`

```json
{
  "success": true,
  "data": {
    "paymentIntent": {
      "id": "epay_01",
      "status": "COMPLETED",
      "amountPaise": 3195344,
      "orderStatus": "PAID",
      "paymentCompleted": true,
      "failureReason": null
    }
  }
}
```

Also listen for FCM: `ECOMMERCE_ORDER_CONFIRMED`, `ECOMMERCE_PAYMENT_FAILED`, `ECOMMERCE_PAYMENT_EXPIRED`.

**Non-production harness:** `POST /app/shop/orders/{orderId}/test-harness/complete-payment` (only when server exposes test harness metadata on order/quote).

---

## 11. Orders — list, detail, invoice, pickup

### `GET /app/shop/orders?limit=20&cursor=`

**Response**

```json
{
  "success": true,
  "data": [
    {
      "id": "eord_01",
      "orderNumber": "SG-2026-00042",
      "status": "PAID",
      "statusLabel": "PAID",
      "paymentMethod": "ONLINE",
      "totalPaise": 3195344,
      "createdAt": "2026-03-15T10:06:00.000Z",
      "fulfilmentMode": "BRANCH_PICKUP"
    }
  ],
  "meta": { "limit": 20, "nextCursor": null, "hasMore": false }
}
```

(List rows use the same mapper as detail with fewer fields in practice — always handle unknown keys.)

### `GET /app/shop/orders/{orderId}`

Full `mapCustomerOrder` shape (see §9). Includes `fulfilmentStatus`, `deliveryTracking` for delivery orders, `refundStatus`, `invoiceAvailable`.

### `GET /app/shop/orders/{orderId}/invoice.pdf`

Binary PDF when `invoiceAvailable: true`.

### `POST /app/shop/orders/{orderId}/confirm-pickup`

**Body:** `{ "expectedVersion": 1 }` (pickup orders, customer confirms collection).

---

## 12. Cancel and return

### `POST /app/shop/orders/{orderId}/cancel`

**Headers:** `X-Idempotency-Key`

**Request**

```json
{
  "reason": "Ordered by mistake — please cancel before dispatch"
}
```

### `GET /app/shop/orders/{orderId}/cancellation`

Cancellation state for the order.

### `POST /app/shop/orders/{orderId}/cancellation-requests`

**Headers:** `X-Idempotency-Key` — when policy requires staff-approved cancellation.

### `GET /app/shop/orders/{orderId}/return`

Latest return/exchange request.

### `POST /app/shop/orders/{orderId}/return-requests`

**Headers:** `X-Idempotency-Key`

**Request**

```json
{
  "reason": "Size does not fit — requesting exchange",
  "kind": "EXCHANGE",
  "evidenceNote": "Unworn, tags intact"
}
```

---

## 13. Push notifications & inbox (ecommerce)

Register FCM: `POST /app/devices/fcm-token` (see [FCM_CUSTOMER_APP_INTEGRATION.md](./FCM_CUSTOMER_APP_INTEGRATION.md)).

### Inbox

`GET /app/notifications` — deduplicated rows; `type: "ECOMMERCE"` for shop events.

### FCM `messageType` (shop)

| Type | Typical `deepLink` |
|------|-------------------|
| `ECOMMERCE_PRODUCT_PROMOTION` | `/shop` or product path |
| `ECOMMERCE_CATEGORY_PROMOTION` | category / shop |
| `ECOMMERCE_NEW_ARRIVAL`, `ECOMMERCE_OFFER` | `/shop` |
| `ECOMMERCE_GOLD_RATE_UPDATED` | `/shop` |
| `ECOMMERCE_ORDER_CONFIRMED` | `/shop/order/{orderId}` |
| `ECOMMERCE_PAYMENT_FAILED`, `ECOMMERCE_PAYMENT_EXPIRED` | order path |
| `ECOMMERCE_FULFILMENT_UPDATE`, `ECOMMERCE_COD_UPDATE` | order path |
| `ECOMMERCE_REFUND_COMPLETED`, `ECOMMERCE_CANCELLATION_UPDATE` | order path |

**FCM `data` strings (promotions + gold-rate shop):**

`productId`, `categoryId`, `promotionKind`, `campaignBusinessKey`, `deepLink`, `rateId`, `rateSource`, `purity`, `ratePerGramPaise`, `effectiveAt`, `branchId`.

Scheme gold-rate pushes use `SCHEME_GOLD_RATE_UPDATED` and `/gold-rate/current` (not shop catalog rates).

---

## 14. Recommended checkout sequence

```text
GET  /shop/availability
GET  /shop/store-policies          → show disclosure
GET  /shop/categories + /products
PUT  /shop/cart
GET  /shop/fulfilment-options
POST /shop/quotes                  (+ idempotency)
POST /shop/orders                  (+ idempotency, quoteId)
POST /shop/orders/{id}/payment-intents   (ONLINE only)
GET  /shop/orders/{id}/payment-intents/{attemptId}  (poll)
GET  /shop/orders/{id}             (confirm PAID / fulfilment)
```

---

## 15. Endpoint index (`/app`)

| Method | Path |
|--------|------|
| GET | `/app/home/banners` |
| GET | `/app/shop/availability` |
| GET | `/app/shop/banners` |
| GET | `/app/shop/categories` |
| GET | `/app/shop/store-policies` |
| GET | `/app/shop/products` |
| GET | `/app/shop/products/:productIdOrSlug` |
| GET/POST | `/app/shop/addresses` |
| PATCH | `/app/shop/addresses/:addressId` |
| GET/PUT | `/app/shop/cart` |
| GET | `/app/shop/fulfilment-options` |
| POST | `/app/shop/quotes` |
| GET | `/app/shop/quotes/:quoteId` |
| POST | `/app/shop/quotes/:quoteId/cancel` |
| POST/GET | `/app/shop/orders` |
| GET | `/app/shop/orders/:orderId` |
| GET | `/app/shop/orders/:orderId/invoice.pdf` |
| POST | `/app/shop/orders/:orderId/confirm-pickup` |
| POST | `/app/shop/orders/:orderId/cancel` |
| GET | `/app/shop/orders/:orderId/cancellation` |
| POST | `/app/shop/orders/:orderId/cancellation-requests` |
| GET | `/app/shop/orders/:orderId/return` |
| POST | `/app/shop/orders/:orderId/return-requests` |
| POST | `/app/shop/orders/:orderId/payment-intents` |
| GET | `/app/shop/orders/:orderId/payment-intents/:paymentAttemptId` |
| POST | `/app/shop/orders/:orderId/test-harness/complete-payment` |

---

## 16. Common error codes

| Code | When |
|------|------|
| `ECOMMERCE_NOT_AVAILABLE` | Store/plan off |
| `FEATURE_NOT_ENTITLED` | Plan lacks ecommerce |
| `CHECKOUT_NOT_READY` | Tax/policies/HSN not configured |
| `FULFILMENT_UNAVAILABLE` | Pickup branch or pincode invalid |
| `INSUFFICIENT_STOCK` | Tracked SKU oversold |
| `PRICE_NOT_COMPUTABLE` | Missing gold rate or invalid product pricing |
| `VERSION_CONFLICT` | Cart/address version mismatch |
| `IDEMPOTENCY_KEY_REUSED` | Same key, different body |
| `ORDER_NOT_PAYABLE` | Wrong order status for payment |
| `PAYMENT_ATTEMPT_IN_PROGRESS` | Poll existing attempt |

Always surface `error.traceId` in support logs.
