# API Contract — Panel Index

Split from the full SwarnaGrow v1.2 contract for frontend teams.

| Panel | Doc | Routes | Auth subject |
|---|---|---:|---|
| Super Admin (Platform) | [API_CONTRACT_SUPER_ADMIN.md](./API_CONTRACT_SUPER_ADMIN.md) | 51 | `PLATFORM_USER` |
| Admin (Tenant portal) | [API_CONTRACT_ADMIN.md](./API_CONTRACT_ADMIN.md) | 188* | `TENANT_USER` (owner/admin/manager) |
| Collection agent app | [API_CONTRACT_STAFF.md](./API_CONTRACT_STAFF.md) | 25 | `TENANT_USER` (`COLLECTION_AGENT`) |
| Customer Web / App | [API_CONTRACT_CUSTOMER.md](./API_CONTRACT_CUSTOMER.md) | 59 | `CUSTOMER` (+ public OTP/pay/signup) |
| Full combined | [API_CONTRACT.md](./API_CONTRACT.md) | 279 | all |

\*Admin doc still lists `/staff/*` for historical reference; staff panel contract is the dedicated guide for field apps.

## Quick mapping

```text
/platform/*          → Super Admin panel
/admin/*            → Admin panel
/staff/*            → Collection agent app (see API_CONTRACT_STAFF.md; full staff routes in API_CONTRACT.md)
/auth/*             → Admin panel (tenant login)
/app/*              → Customer web / app
/public/auth/otp/*  → Customer login
/public/pay/*       → Customer payment pages
/public/signup/*    → Super Admin / jeweller onboarding
/webhooks/*         → Backend only (not a panel)
```

## Shared

- Envelopes, headers, money units: see Conventions in each panel doc
- Webhooks (`POST /api/v1/webhooks/phonepe/:tenantId`): server-to-server only — not assigned to a UI panel
