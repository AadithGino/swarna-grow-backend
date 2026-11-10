# Demo Builder — Phase 1/2 foundation (this change)

Scope: DB models/schema, the single-source policy module, the clone-policy registry + its CI
gate, env feature flags, and two small hardening fixes to existing code. No routes, no
controllers, no services, no UI. Nothing in this change is reachable from any API yet — it is
inert until phase 3+ wires it up. This file is the map for that next phase.

## What this change adds

- `src/models/demo.models.js` — `DemoTemplate`, `DemoTemplateVersion`, `DemoInstance`,
  `DemoProvisionJob`, `DemoCloneMap`, `DemoEvent`, exported via `src/models/index.js`.
- `src/constants/enums.js` — `DemoTemplateStatus`, `DemoTemplateVersionStatus`,
  `DemoInstanceStatus`, `DemoProvisionJobKind`, `DemoProvisionJobStatus`, `DemoClonePolicy`,
  `DemoEventType`, `DemoCheckoutMode`.
- `Tenant` (`src/models/identity.models.js`): `isDemo`, `demoInstanceId`, `demoGenerationId`,
  `demoTemplateVersionId`, `prospectContactMobile`, `branding.splash*`; `mobile` is now
  conditionally required (`!isDemo`); a new partial unique index `mobile_1_live_only` is
  *declared* but not yet live — see the mobile-index rollout below.
- `Session`: `demoSession`, `demoInstanceId`, `demoGenerationId`, `demoLinkVersion` — fields
  only, not read by `authenticate`/`refresh` yet.
- `Customer`: `isDemo` — field only, not set by any creation path yet.
- `src/lib/demo-policy.js` — the "single trusted source of policy" the plan asks for
  (section 6). Pure, additive, reads only server-owned state passed in by the caller.
- `src/lib/demo-clone-registry.js` + `scripts/check-demo-clone-registry-coverage.mjs` — a
  first-pass COPY/REBUILD/SYNTHETIC/EXCLUDE decision for every tenant-scoped model in the
  codebase (103 models checked), with a coverage check meant to run in CI. **This first pass
  is not a substitute for the plan's own phase-1 model-by-model audit** — see the calibration
  note at the top of `demo-clone-registry.js`, especially for the digital-metal and ecommerce
  groups.
- `src/lib/live-tenant-filter.js` — the shared "exclude demo tenants from platform reporting"
  helper from plan section 11. Not yet called anywhere.
- `src/lib/digital-metals-demo-policy.js` — `resolveDigitalMetalsCheckoutMode()` now takes an
  optional `tenant` argument. Every existing call site that omits it is unaffected (tested
  behaviourally unchanged below).
- `src/lib/tenant-limits.js` — `assertSubscriptionActive()` now explicitly exempts
  `tenant.isDemo` instead of relying on an accidental default (see "review findings" below).
- `src/config/env.js` — `DEMO_BUILDER_ENABLED`, `DEMO_PUBLIC_ENTRY_ENABLED`,
  `TENANT_DEMO_SIMULATION_ENABLED`, `DEMO_DEFAULT_EXPIRY_DAYS`, `DEMO_MAX_EXPIRY_DAYS`,
  `DEMO_PURGE_RETENTION_DAYS`, `DEMO_MAX_ACTIVE_INSTANCES`. All default to `false`/sane
  numbers; none affect existing behaviour until read by code that doesn't exist yet.
- `scripts/migrate-tenant-demo-mobile-index-dry-run.mjs` — step 1 of the mobile-index
  rollout (see below); backfills `isDemo: false`, reports tenants with no usable mobile and
  any duplicate mobiles among live tenants. Creates/drops no index itself.

## What is explicitly NOT done (do these in order)

1. **Mobile index rollout (blocks nothing yet, but must happen before any demo tenant is
   created)**: run `migrate-tenant-demo-mobile-index-dry-run.mjs`, resolve whatever it
   reports, then follow the exact `sync-indexes.js` sequence written at the top of that
   script. Until `mobile_1_live_only` is live, don't create a tenant with `isDemo: true` —
   it will likely violate the existing unconditional `mobile_1` index, since that schema path
   is still `required: !isDemo` but has no value for a demo tenant.
2. **Auth/session wiring** (plan 6.1): `authenticate`/`refresh` in `auth.middleware.js` don't
   read `demoSession`/`demoInstanceId`/`demoGenerationId`/`demoLinkVersion` yet. A session
   created with those fields set today would authenticate exactly like an ordinary session —
   there is no demo-specific restriction live. Do not start issuing demo sessions before this
   lands.
3. **Payment adapter wiring** (plan 6.3): only `digital-metals-checkout-init.js`'s single call
   to `resolveDigitalMetalsCheckoutMode()` can even accept a tenant now, and nothing passes
   one yet. The other ~3 digital-metal payment services, and the entire ecommerce checkout/
   refund/return path, have no demo-awareness at all. `mustBlockExternalDispatch()` in
   `demo-policy.js` exists but nothing calls it — workers/schedulers will still attempt real
   provider calls for a demo tenant today if one exists in the DB.
4. **Clone registry → actual service**: the registry is a lookup table, not executable
   cloning logic. `demo-template.service.js` / `demo-provision.service.js` (plan 6) don't
   exist.
5. **Reporting filters** (plan 11): `live-tenant-filter.js` isn't called from
   `src/services/platform.service.js` yet. Concretely: the subscription-tier aggregate, the
   `tenants()` status-count aggregate, and the dashboard's tenant total will all include demo
   tenants the moment one exists, until that service is touched.
6. **Platform-operator permission system**: see review finding #1 below — this doesn't exist
   yet at all, for anything, not just demos. Needs its own design before "demo-management
   permissions" can be enforced as anything other than "any platform user."

## Plan-review findings this change acts on

- `assertSubscriptionActive` would have passed for a demo tenant today purely because
  `subscriptionSchema`'s own default (`status: TRIAL`, no `trialEndsAt`) happens to short-
  circuit every throw condition — not because anything said so on purpose. Hardened with an
  explicit `isDemo` check instead of leaving that to chance.
- `resolveDigitalMetalsCheckoutMode()` was NODE_ENV/PROVIDER_MODE-only, exactly what plan
  section 2 flags as unsuitable for a per-tenant trusted-demo policy. Extended additively
  (optional `tenant` param) rather than rewired, since rewiring every caller is phase 3 work
  and touching payment code deserves its own review pass, not a drive-by.
- `requirePlatformCapability` (the only "capability" middleware in the codebase) is a tenant
  subscription feature-entitlement check, not a platform-operator permission system — there is
  currently no per-action gate on platform routes beyond `requireSubject("PLATFORM_USER")`.
  Not something this foundation pass can retrofit safely; flagged for whoever designs phase 1's
  "explicit demo-management permissions" requirement.
- `TenantStatus` needs no new value: a demo tenant can simply be `ACTIVE`, flagged via
  `isDemo`, and the existing `authenticate` status check (`ACTIVE`/`PENDING_SETUP`) already
  passes it unmodified.
- `Customer.mobile` uniqueness is per-tenant (`{tenantId, mobile}`), not global, so synthetic
  demo customer mobiles need no special-casing — only `Tenant.mobile` (globally unique) does.
