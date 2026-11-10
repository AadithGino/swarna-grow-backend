# Customer profile edit & address management APIs

**Base URL:** `https://api.swarnagrow.com/api/v1`  
**Auth:** `Authorization: Bearer <customerAccessToken>`  
**Audience:** Flutter / customer portal (`/app/*`)

Shop addresses and digital-metals delivery addresses share the same address book (`EcommerceCustomerAddress`). Updating via either path updates the same records.

---

## 1. Edit customer profile

Partial update of the logged-in customer. Mobile and branch are **not** editable by the customer.

| | |
|---|---|
| Methods | `PATCH` or `PUT` |
| Path | `/app/profile` |
| Idempotency | Not required |

### Request

```http
PATCH /api/v1/app/profile
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json
```

```json
{
  "name": "Anu Joseph",
  "email": "anu@example.com",
  "address": {
    "line1": "Rose Villa",
    "line2": "Near temple",
    "city": "Kochi",
    "state": "Kerala",
    "pincode": "682001"
  }
}
```

All of `name`, `email`, and `address` are optional. Send only fields you want to change.

`address` may also be a plain string:

```json
{
  "name": "Anu Joseph",
  "address": "Rose Villa, Near temple, Kochi, Kerala, 682001"
}
```

Extra unknown fields are ignored.

### Success response `200`

```json
{
  "success": true,
  "data": {
    "id": "cust_01ANU",
    "customerNumber": "C-1001",
    "passbookNumber": "PB-1001",
    "name": "Anu Joseph",
    "mobile": "+919876543210",
    "email": "anu@example.com",
    "address": "Rose Villa, Near temple, Kochi, Kerala, 682001",
    "mobileImmutable": true,
    "memberSince": "2025-01-12T10:00:00.000Z",
    "profileComplete": true,
    "branch": {
      "id": "br_01",
      "name": "MG Road",
      "code": "MGR",
      "address": "MG Road, Kochi",
      "mobile": "+914841234567"
    },
    "version": 5,
    "tenant": {
      "id": "ten_01",
      "code": "EVOLUXE",
      "name": "Evoluxe Jewellers"
    }
  }
}
```

`kyc` may be present or omitted depending on tenant KYC settings.

### Errors

| Status | Code | When |
|--------|------|------|
| `400` | `VALIDATION_ERROR` | Invalid name/email/address shape |
| `401` | `UNAUTHORIZED` | Missing/invalid token |
| `403` | — | Customer app writes disabled for tenant |
| `404` | `NOT_FOUND` | Customer not found |

---

## 2. Shop addresses — list / create / edit / delete

### 2.1 List

```http
GET /api/v1/app/shop/addresses
Authorization: Bearer eyJhbGciOi...
```

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "eaddr_01HOME",
        "label": "Home",
        "recipientName": "Anu Joseph",
        "mobile": "+919876543210",
        "line1": "Rose Villa",
        "line2": "Near temple",
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

### 2.2 Create

```http
POST /api/v1/app/shop/addresses
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json
X-Idempotency-Key: 3fa85f64-5717-4562-b3fc-2c963f66afa6
```

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

**Response `201`**

```json
{
  "success": true,
  "data": {
    "id": "eaddr_01HOME",
    "label": "Home",
    "recipientName": "Anu Joseph",
    "mobile": "+919876543210",
    "line1": "Rose Villa",
    "line2": "Near temple",
    "city": "Kochi",
    "state": "Kerala",
    "pincode": "682001",
    "isDefault": true,
    "version": 1
  }
}
```

### 2.3 Edit

```http
PATCH /api/v1/app/shop/addresses/eaddr_01HOME
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json
```

```json
{
  "expectedVersion": 1,
  "line1": "Rose Villa Annex",
  "pincode": "682016",
  "isDefault": true
}
```

All body fields are optional. `expectedVersion` is recommended for optimistic concurrency; omit it to skip the version check.

**Response `200`**

```json
{
  "success": true,
  "data": {
    "id": "eaddr_01HOME",
    "label": "Home",
    "recipientName": "Anu Joseph",
    "mobile": "+919876543210",
    "line1": "Rose Villa Annex",
    "line2": "Near temple",
    "city": "Kochi",
    "state": "Kerala",
    "pincode": "682016",
    "isDefault": true,
    "version": 2
  }
}
```

### 2.4 Delete

```http
DELETE /api/v1/app/shop/addresses/eaddr_01HOME
Authorization: Bearer eyJhbGciOi...
```

**Response `200`**

```json
{
  "success": true,
  "data": {
    "id": "eaddr_01HOME",
    "deleted": true
  }
}
```

If the deleted address was default, another remaining address (most recently updated) is promoted to default when one exists.

### Address errors

| Status | Code | When |
|--------|------|------|
| `400` | `VALIDATION_ERROR` | Invalid body |
| `404` | `NOT_FOUND` | Address not owned by customer |
| `409` | `VERSION_CONFLICT` | `expectedVersion` does not match |
| `403` | — | Ecommerce not operational for tenant |

---

## 3. Digital metals delivery addresses — edit / delete

Same address book as shop. Paths are under `/app/digital-metals/delivery-addresses`. Digital metals must be active for the tenant.

### 3.1 Edit

```http
PATCH /api/v1/app/digital-metals/delivery-addresses/eaddr_01HOME
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json
```

```json
{
  "expectedVersion": 2,
  "recipientName": "Anu J",
  "mobile": "+919876543210",
  "label": "Office"
}
```

**Response `200`** — same address object shape as shop (`id`, `label`, `recipientName`, `mobile`, `line1`, `line2`, `city`, `state`, `pincode`, `isDefault`, `version`).

### 3.2 Delete

```http
DELETE /api/v1/app/digital-metals/delivery-addresses/eaddr_01HOME
Authorization: Bearer eyJhbGciOi...
```

**Response `200`**

```json
{
  "success": true,
  "data": {
    "id": "eaddr_01HOME",
    "deleted": true
  }
}
```

### Related (already existed)

| Method | Path |
|--------|------|
| `GET` | `/app/digital-metals/delivery-addresses` |
| `POST` | `/app/digital-metals/delivery-addresses` (`X-Idempotency-Key` required) |

---

## Quick reference

| Action | Method | Path |
|--------|--------|------|
| Edit profile | `PATCH` / `PUT` | `/app/profile` |
| List shop addresses | `GET` | `/app/shop/addresses` |
| Create shop address | `POST` | `/app/shop/addresses` |
| Edit shop address | `PATCH` | `/app/shop/addresses/:addressId` |
| Delete shop address | `DELETE` | `/app/shop/addresses/:addressId` |
| List DM addresses | `GET` | `/app/digital-metals/delivery-addresses` |
| Create DM address | `POST` | `/app/digital-metals/delivery-addresses` |
| Edit DM address | `PATCH` | `/app/digital-metals/delivery-addresses/:addressId` |
| Delete DM address | `DELETE` | `/app/digital-metals/delivery-addresses/:addressId` |

Local base URL for development: `http://localhost:4050/api/v1`.
