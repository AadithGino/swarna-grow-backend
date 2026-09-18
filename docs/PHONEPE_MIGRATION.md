# PhonePe integration — Client ID / Secret SDK

## Credential model

SwarnaGrow uses PhonePe's official **`@phonepe-pg/pg-sdk-node`** package with OAuth-style
**Client ID**, **Client Secret**, and **Client Version** credentials per tenant.

Each jeweller stores credentials via:

`PUT /api/v1/platform/tenants/:tenantId/integrations/payment-gateway`

| Field | Notes |
|-------|--------|
| `clientId` | From PhonePe Business → Developer Settings → API Keys |
| `clientSecret` | Sealed at rest (write-only) |
| `clientVersion` | Numeric version from PhonePe dashboard |
| `webhookUsername` | Configured by jeweller in PhonePe → Webhooks tab |
| `webhookPassword` | Sealed at rest (write-only) |
| `environment` | `SANDBOX` or `PRODUCTION` |

`paymentGatewayConfigured` is true when `clientId` is present on the tenant record.

## Webhook setup (one-time per tenant)

Each jeweller must configure their webhook URL once in the PhonePe dashboard:

```
{PUBLIC_BASE_URL}/api/v1/webhooks/phonepe/{tenantId}
```

Example (local dev):

```
http://localhost:4000/api/v1/webhooks/phonepe/tnt_...
```

Verification uses the **`Authorization` header** and
`StandardCheckoutClient.validateCallback(username, password, authorization, rawBody)`.

## API surface

| Flow | Endpoint / method |
|------|-------------------|
| Web checkout (redirect) | Payment intent / payment link flows → `StandardCheckoutClient.pay()` |
| Native app SDK token | `POST /api/v1/app/schemes/:schemeId/pay/sdk-order` → `{ token, merchantOrderId, providerOrderId }` |
| Order status | `phonePeProvider.getOrderStatus(merchantOrderId, credentials)` |
| Verify integration | `POST /platform/tenants/:id/integrations/payment-gateway/verify` — probes with `getOrderStatus` |

Internal reference id is **`merchantOrderId`** at the provider boundary (maps from
`PaymentIntent._id` or `PaymentLink._id`).

## SDK behaviour notes (observed from installed package)

- Package: `@phonepe-pg/pg-sdk-node`
- **`getInstance` is a process-wide singleton**, not per-merchant: a second call with different
  credentials throws `PhonePeException`. Multi-tenant support uses **`new StandardCheckoutClient(...)`**
  with a backend cache keyed by `(clientId, environment)`.
- `validateCallback(...)` **throws** `PhonePeException` on invalid callbacks (not boolean).
- Callback `type` is a **numeric enum** (`CallbackType.CHECKOUT_ORDER_COMPLETED = 6`, etc.).
- Refund callbacks (`PG_REFUND_*`) are logged and marked complete — settlement logic deferred.

## Testing performed

### Unit / integration tests (mocked or in-memory DB)

- `tests/phonepe-provider.test.js` — client cache, mock-mode pay/sdk-order, callback normalization
- `tests/webhook-processors-sdk.test.js` — SDK `{ type, payload }` completion, failure, refund

### Real PhonePe sandbox

**Not run yet** — requires live sandbox Client ID/Secret from the jeweller's PhonePe Business
dashboard and `PROVIDER_MODE=live`. Manual steps:

1. Store sandbox credentials on a demo tenant
2. Call verify integration endpoint
3. Create a payment intent and complete checkout in PhonePe sandbox UI
4. Confirm webhook arrives with `Authorization` header and payment lands `SUCCESS`
