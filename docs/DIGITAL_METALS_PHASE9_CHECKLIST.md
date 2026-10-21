# Digital Metals — Phase 9 requirement checklist

Legend: **Done** · **Partial** · **Blocked**

**Phase 9 status: Done** (2026-10-19 verification close-out)

## Source identity (2026-10-19)

| Component | Path / ref |
|-----------|------------|
| Backend | `/Users/aadithgino/Developer/Swarna Grow/swarnagrow-backend` · branch `ecommerce` · `3df60d8246bc8860e66bcb947f14f907aa070f83` |
| Tenant Admin | `/Users/aadithgino/Developer/Swarna Grow/SwarnaGrow-Tenant-Admin` · branch `ecommerce` · `a9d83e557ea05b4364a410483b6e3efdff81a42a` |
| API (smoke) | `http://localhost:4050` · cwd backend · **`PORT=4050` `PROVIDER_MODE=mock`** |
| Worker | cwd backend · **`PROVIDER_MODE=mock`** (mock `.mock-storage/`) |
| Portal | `http://localhost:5173` · cwd Tenant Admin · `NEXT_PUBLIC_USE_MOCKS=false` |

## Statement pipeline diagnosis (resolved)

| Stage | Finding |
|-------|---------|
| Root cause | Dev API/worker on **`PROVIDER_MODE=live`** (or default S3) → artifact upload **`Could not load credentials from any providers`**; UI poll hung on **PENDING** |
| Fix for local smoke | Run API + worker with **`PROVIDER_MODE=mock`**; bounded **`pollArtifactViaApi`** (90s) + mock **`digital-metals-outbox-dispatch-once.js`** |
| Download URL | Presign uses mock storage when **`PROVIDER_MODE=mock`** on API |

## Phase 8 boundary enforcement (prerequisite)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| Downstream invalidation persisted | **Done** | `INVALIDATED` snapshot status |
| Invalid snapshots excluded as opening baseline | **Done** | aggregation filters |
| Revision reuses superseded sources | **Done** | included-source upsert |
| Live report recomputation flag | **Done** | outstanding invalidations only |
| Regression tests | **Done** | `tests/digital-metals-phase9-boundaries.test.js` |

## 1–5 Implementation areas

Procurement UI, durable documents, portal panels, hedge UI, contract coverage — **Done** (see spec + git tree).

## 6. Verification (2026-10-19)

| Check | Result | Notes |
|-------|--------|-------|
| `npm test -- tests/digital-metals*.test.js tests/route-coverage-digital-metals.test.js` | **Pass** | **123** tests, **0** fail (`NODE_ENV=test`, MongoMemoryReplSet) |
| `npm run check` | **Pass** | 452 contract routes |
| `scripts/digital-metals-phase9-api-smoke.js` | **Pass** | 4/4 supertest flows |
| Document reliability tests | **Pass** | `tests/digital-metals-phase9-documents.test.js` |
| PDF samples + visual QA | **Done** | `docs/phase9-pdf-samples/` (6 PDFs + PNG); multipage statement footers/`ug`/disclaimer reviewed |
| Playwright 8-area smoke | **Pass** | **8/8** — `docs/phase9-browser-smoke-results-2026-10-19T05-28-41-587Z.json` + `docs/phase9-browser-smoke-results-latest.json` |

### Browser smoke areas (`FRONTEND_BASE=http://localhost:5173`, `API_BASE=http://localhost:4050/api/v1`)

| Area | Result |
|------|--------|
| Portal ↔ API connectivity | **Pass** |
| Procurement UI (maker + approver Approve) | **Pass** (procurement list fixed: `contractPayload` on RTK data) |
| Hedge deep link / refresh | **Pass** |
| Hedge invalidation banner | **Pass** |
| Admin sell/payout/redemption surfaces | **Pass** |
| Customer statement + download-url after READY | **Pass** (smoke customer `9847099901`, mock storage) |
| Paused trading + customer capability | **Pass** |
| Permission denial (Kochi staff) | **Pass** |

**Run:** `npm run test:digital-metals-phase9-browser-smoke` (requires dev:api + worker on mock storage, portal :5173, `digital-metals-phase9-browser-setup.js` seed).

## Deferred (Phase 10+)

- Push notification document-ready campaigns
- CI wiring for Phase 9 browser smoke on every PR
