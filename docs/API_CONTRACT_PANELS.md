# API Contract — Panel Index

Split from the full SwarnaGrow v1.2 contract for frontend teams.

| Panel | Doc | Routes | Auth subject |
|---|---|---:|---|
| Super Admin (Platform) | [API_CONTRACT_SUPER_ADMIN.md](./API_CONTRACT_SUPER_ADMIN.md) | 51 | `PLATFORM_USER` |
| Admin (Tenant portal + Staff app) | [API_CONTRACT_ADMIN.md](./API_CONTRACT_ADMIN.md) | 188 | `TENANT_USER` |
| Customer Web / App | [API_CONTRACT_CUSTOMER.md](./API_CONTRACT_CUSTOMER.md) | 59 | `CUSTOMER` (+ public OTP/pay/signup) |
| Full combined | [API_CONTRACT.md](./API_CONTRACT.md) | 279 | all |

## Quick mapping

```text
/platform/*          → Super Admin panel
/admin/*            → Admin panel
/staff/*            → Admin panel (staff companion app)
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
