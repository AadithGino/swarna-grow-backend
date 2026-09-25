# KAIRALI tenant portal — coverage runbook

Storage uploads stay on your current `PROVIDER_MODE` (KYC/branding uploads are out of scope here).

## One-shot automation

From `swarnagrow-backend` (API + frontend running on `:4000` / `:5173`):

**Operational flows (shorter):**

```bash
npm run test:tenant-coverage
```

Results: `docs/tenant-coverage-results.json`

**Full UI parity (screens, KPIs, all 14 reports, reminders, gap actions):**

```bash
npm run test:tenant-ui-parity
```

Results: `docs/tenant-ui-parity-results.json`  
Report KPI contract (API-only, row-sum vs portfolio): `docs/tenant-report-kpi-contract.json` via `npm run audit:tenant-report-kpi-contract`

Seeds used by parity run:

- `npm run seed:pending-handover`
- `npm run seed:tenant-coverage-gaps` (draft plan, tagged reverse payment; APPROVED redemption best-effort)

## What the coverage spec exercises

| Area | Action |
| --- | --- |
| Dashboard | `THIS_MONTH` widgets visible vs API |
| Dues | Full-year range, Collect on first payable row, Link + Bell bulk on a fixed row |
| Cash control | Accept one pending handover, seed reject path if two pending exist |
| Maturity | Summary stat cards, approve → complete handover (cash / gold / purchase when queue allows) |
| Redemption | Reject an approved request when available |
| Premature | Approve + complete pending premature redemption when present |
| Schemes | Activate a draft plan (AU95774 or latest draft) |
| Enrolments | New enrol on flexible-free and gold-weight plans |
| Collections | Reverse a successful cash payment (with reason), open pending tab reconcile/poll |
| Reminders | Message log / Manual push / Templates (preview) / Schedule / Quota; **Estimate reach** on manual push; dues **Bell** bulk reminder |
| Staff | Directory tabs (sessions/permissions placeholders removed — use staff detail) |
| Reports | CSV export on Collection report |

## Dues workboard notes

- **Collect** uses the same payable-range API as enrollment collect. Rows now pass `targetCycle` (flex capped) and due amount hints.
- **Overdue** rows ignore the due-date window filter on the API so month-to-date filters still show older overdue instalments.
- **Link / Bell** POST `schemeIds` (one scheme per row). Flexible schemes are skipped by the backend for WhatsApp reminders.

## What `test:tenant-ui-parity` adds

- All **19** tenant routes + branch detail, customer tabs, enrollment tabs (settlement preview modes when enabled).
- **KPI parity in UI** vs API: dashboard, dues strip, collections summary, reminder stat cards (`/admin/messaging/summary`).
- **All 14 reports**: each summary KPI value must appear on the page (uses `amountDisplay` for money). Row-sum vs KPI rules are documented in `docs/tenant-report-kpi-contract.json` and `scripts/check-report-totals.js` — many reports are **PORTFOLIO_KPI** by design, not paginated row totals.
- **Gap actions** (best-effort): activate draft plan, reverse tagged payment, reject approved redemption, complete redemption matrix — skipped when KAIRALI has no eligible row.
- **Reminders** are not the audit-admin messaging APIs; the spec exercises the **Reminder centre** UI (tabs, template preview, push audience estimate). It does **not** submit a live push broadcast or verify background delivery jobs in DB.

Latest run: `docs/tenant-ui-parity-results.json` (all steps green as of last local run).

## Manual pass (5–10 min)

1. **Dashboard** — Period `THIS_MONTH`, branch `All`; confirm widget numbers match `/admin/dashboard?period=THIS_MONTH`.
2. **Maturity** — List view + stat cards (`Upcoming 30 days`, `Matured today`, `Matured not redeemed`) match list filters.
3. **Reports** — Open `Collection`, click **Download CSV**; open `Outstanding` and confirm KPI cards (totals row not required).

## Seed pending handover

`npm run seed:pending-handover` creates a **PENDING** handover when none exist (records a small cash payment first if the staff float is empty).
