import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JobStatus } from "../src/constants/enums.js";
import { PushDeviceDeliveryStatus } from "../src/constants/enums.js";
import {
  aggregateDeliveryStatusRows,
  evaluateStagingCampaignVerdict,
  redactStagingReport,
} from "../src/lib/fcm-staging-verdict.js";
import { diffSharedFcmMetrics } from "../src/lib/fcm-redis-metrics.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function stagingReportFromOutput(output) {
  const text = String(output ?? "").trim();
  const line = text.split("\n").find((row) => row.trim().startsWith("{"));
  if (!line) return null;
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
}

test("evaluateStagingCampaignVerdict requires all succeeded deliveries", () => {
  const ok = evaluateStagingCampaignVerdict({
    requestedUniqueCustomers: 10,
    discoveredUniqueCustomers: 10,
    logicalMessages: 10,
    duplicateLogicalMessages: 0,
    missingLogicalMessages: 0,
    campaignStatus: JobStatus.COMPLETED,
    deliveries: {
      expectedDevices: 10,
      totalRows: 10,
      missingDeliveryRows: 0,
      queued: 0,
      processingActive: 0,
      processingExpired: 0,
      retryableFailed: 0,
      succeeded: 10,
      permanentFailed: 0,
      deadLetter: 0,
    },
  });
  assert.equal(ok.ok, true);

  const deadLetter = evaluateStagingCampaignVerdict({
    requestedUniqueCustomers: 10,
    discoveredUniqueCustomers: 10,
    logicalMessages: 10,
    duplicateLogicalMessages: 0,
    missingLogicalMessages: 0,
    campaignStatus: JobStatus.COMPLETED,
    deliveries: {
      expectedDevices: 10,
      totalRows: 10,
      missingDeliveryRows: 0,
      queued: 0,
      processingActive: 0,
      processingExpired: 0,
      retryableFailed: 0,
      succeeded: 9,
      permanentFailed: 0,
      deadLetter: 1,
    },
  });
  assert.equal(deadLetter.ok, false);
  assert.ok(deadLetter.errors.includes("DELIVERIES_DEAD_LETTER"));
});

test("shared metrics delta reflects worker-visible redis counters", () => {
  const delta = diffSharedFcmMetrics(
    { counters: { limiter_denied_global: 1 } },
    { counters: { limiter_denied_global: 4, delivery_succeeded: 2 } },
  );
  assert.deepEqual(delta, { limiter_denied_global: 3, delivery_succeeded: 2 });
});

test("redactStagingReport rejects token-like report payloads", () => {
  const out = redactStagingReport({ note: "leaked-fcm-token-value" });
  assert.equal(out.redactionFailed, true);
});

test("aggregateDeliveryStatusRows maps delivery statuses", () => {
  const agg = aggregateDeliveryStatusRows([
    { _id: PushDeviceDeliveryStatus.SUCCEEDED, count: 3 },
    { _id: PushDeviceDeliveryStatus.QUEUED, count: 1 },
  ]);
  assert.equal(agg.succeeded, 3);
  assert.equal(agg.queued, 1);
});

test("staging CLI confirmation and production guards", () => {
  const missingTenant = spawnSync(
    process.execPath,
    ["scripts/fcm-staging-15k.js", "--dry-run=false", "--confirm-live-staging"],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } },
  );
  assert.notEqual(missingTenant.status, 0);
  assert.equal(stagingReportFromOutput(missingTenant.stdout)?.error, "LIVE_STAGING_REQUIRES_TENANT_ID");

  const production = spawnSync(
    process.execPath,
    ["scripts/fcm-staging-15k.js", "--dry-run=false", "--confirm-live-staging", "--tenant-id=tnt_x"],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "production" } },
  );
  assert.notEqual(production.status, 0);
  assert.equal(stagingReportFromOutput(production.stdout)?.error, "LIVE_STAGING_REFUSED_PRODUCTION");
});
