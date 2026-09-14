# API contract coverage

Implemented against SwarnaGrow API contract v1.2 plus the locked decision overrides.

| Surface | Coverage |
|---|---|
| Health and public config | Liveness, readiness, app config, tenant resolution, branch lookup |
| Public onboarding | OTP, signup state, plan selection, gateway initiation, availability |
| Authentication | Tenant/platform login, refresh, logout, device sessions, password reset/change |
| Platform administration | Plans, tenants, credentials, integrations, templates, subscription, invoices, flags, audit, webhook failures |
| Tenant configuration | Profile, branding, operations, branches, staff, subscription, alerts, uploads, gold rates |
| Customers | Search/list, create/update, KYC, nominee, WhatsApp opt, notes, block, 360 view, relations, statements, audit |
| Scheme plans | CRUD lifecycle, duplication, validation/preview, stats, fixed/flexible/gold rules |
| Schemes | Enrolment, details, ledger/passbook, payable positions, intents, lock, maturity, settlement, closure/redemption |
| Payments | Manual modes, pending gateway records, links, intents, callbacks, receipt/passbook, reversal, reconciliation queues, late success |
| Operations | Dues, overdues, maturities/calendar, cash handovers, reminders, messaging, grievances |
| Reporting | Dashboard summaries/charts/activity, operational reports, audit, five-year streaming exports |
| Customer app API | Home, profile/KYC, branches, plans/schemes, flexible payment intents, payment history, notifications, grievances, redemption |
| Staff app API | Home, customers/KYC/nominees, schemes, payments/links, cash, dues/overdues, notifications, grievances |
| Jobs | Webhook processing, outbox, WhatsApp fallback, exports, maturity, overdue, flexible capacity, reminders, expiries, grievance closure |

Intentional exclusions and overrides:

- `/platform/tenants/:tenantId/block` is not registered.
- `EXTEND_FLEXIBLE_PHASE` is rejected.
- Pending gateway attempts use `PaymentStatus.PENDING` according to the final product decision.
- The frontend/customer UI is not part of this backend package.

