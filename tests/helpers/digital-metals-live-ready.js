import { randomUUID } from "node:crypto";
import request from "supertest";
import { seedPlatformAdminToken } from "./platform-mutation-happy-paths.js";

const ASSETS = [
  { metal: "GOLD", finenessPpm: 999_000 },
  { metal: "SILVER", finenessPpm: 999_000 },
];

export async function publishDefaultAssetSettings(app, adminToken) {
  for (const asset of ASSETS) {
    const res = await request(app)
      .patch("/api/v1/admin/digital-metals/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Idempotency-Key", randomUUID())
      .send({
        expectedVersion: 1,
        metal: asset.metal,
        finenessPpm: asset.finenessPpm,
        buyFee: { type: "NONE" },
        sellFee: { type: "NONE" },
        taxLines: [],
      });
    if (res.status >= 400) {
      throw new Error(`settings patch failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
  }
}

export async function platformApproveTaxAndTerms(app, tenantId) {
  const platformToken = await seedPlatformAdminToken(app);
  const tax = await request(app)
    .post(`/api/v1/platform/tenants/${tenantId}/digital-metals/tax-profile/approve`)
    .set("Authorization", `Bearer ${platformToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({ approve: true });
  if (tax.status >= 400) throw new Error(`tax approve failed: ${tax.status}`);
  const terms = await request(app)
    .post(`/api/v1/platform/tenants/${tenantId}/digital-metals/terms/publish`)
    .set("Authorization", `Bearer ${platformToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      termsVersion: "2026-10-01",
      contentSnapshot:
        "Digital Gold & Silver terms v2026-10-01 — immutable customer copy stored server-side.",
      contentRef: "s3://terms/v2026-10-01.pdf",
    });
  if (terms.status >= 400) throw new Error(`terms publish failed: ${terms.status}`);
}

export async function publishGoldRate(app, adminToken, overrides = {}) {
  const res = await request(app)
    .post("/api/v1/admin/digital-metals/rates/publish")
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Idempotency-Key", randomUUID())
    .send({
      metal: "GOLD",
      finenessPpm: 999_000,
      customerBuyRatePerGramPaise: 600_000,
      customerSellRatePerGramPaise: 600_000,
      ...overrides,
    });
  if (res.status >= 400) throw new Error(`rate publish failed: ${res.status}`);
  return res.body.data;
}

export async function makeTenantQuoteReady(app, tenantId, adminToken) {
  await publishDefaultAssetSettings(app, adminToken);
  await platformApproveTaxAndTerms(app, tenantId);
  await publishGoldRate(app, adminToken);
}
