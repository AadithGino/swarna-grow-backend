# WhatsApp & tenant messaging removal map

**Goal:** Remove Meta WhatsApp Cloud, admin messaging workspace, payment-link/receipt WhatsApp shares, reminders over WhatsApp, and platform WhatsApp onboarding. **Keep:** FCM push (`/admin/push/broadcasts`, `Message` channel `PUSH`), Message Central SMS OTP, customer public OTP API unchanged.

## Backend — routes to remove

| Area | Routes / endpoints |
|------|-------------------|
| Public webhooks | `POST /webhooks/whatsapp/:tenantId` |
| Platform | `PUT/POST .../integrations/whatsapp`, tenant template CRUD under platform |
| Admin operations | `/admin/messaging/*`, `/admin/reminders/config` |
| Admin analytics | `POST /admin/analytics/dues/bulk-send-links`, `.../overdues/bulk-send-reminders` |
| Admin customers | `POST .../whatsapp-opt`, `POST .../statement/share-whatsapp` |
| Admin/staff payments | `POST .../payments/:id/share-whatsapp` |

## Backend — services & workers

| Component | Role |
|-----------|------|
| `integrations/whatsapp.provider.js` | Meta send + webhook verify |
| `services/messaging.service.js` | Queue/list/resend WhatsApp templates |
| `services/inbound-message.service.js` | Inbound WA inbox |
| `services/workboard-messaging.service.js` | Dues bulk payment links |
| `services/reminder-scheduler.service.js` | Scheduled WA reminders |
| `services/reminder-message.service.js` | Reminder template bodies |
| `workers/processors.js` | WA branch in `processMessage`, WHATSAPP webhook processor |
| `lib/whatsapp-webhook-identity.js` | Webhook dedupe |
| `services/report-builders/whatsapp-usage.report.js` | WHATSAPP_USAGE report |
| `constants/template-registry.js` | Meta template definitions (platform) |
| Platform `go-live` | WhatsApp + template checklist |

## Backend — call sites (queue / opt-out)

- `customer-notification.service.js` — WHATSAPP leg of notifications
- `payment.service.js` — post-payment WA receipt
- `ecommerce-outbox-processor.js`, `digital-metals-notification-processor.js` — WA eligibility
- `lib/reminder-channel-eligibility.js`
- `signup.service.js` — `otpChannel: "WHATSAPP"` (display only; OTP is SMS/MC)

## Frontend (Tenant Admin)

| Surface | Location |
|---------|----------|
| Platform tenant Setup | WhatsApp card, template registry tab |
| Nav | Engagement → Reminders |
| Admin API | `admin-api.ts` messaging + share-whatsapp + whatsapp-opt |
| Payments / customers / dues / agent collect | Share via WhatsApp actions |
| Settings / dashboard / monitoring | WhatsApp quota & usage widgets |
| Platform dashboard | WhatsApp sent metrics |

## Flutter / customer portal

No API contract changes required for OTP. Remove copy that says “WhatsApp OTP” where present; clients already use `/public/auth/otp/*`.

## Data model (retain, stop writing)

- `Customer.whatsappOptedOutAt` — legacy field, ignore
- `Message` with `channel: "WHATSAPP"` — stop creating; worker no-ops legacy rows
- `integrationSecrets.whatsapp`, `TemplateDefinition` — stop configuring; optional later migration
