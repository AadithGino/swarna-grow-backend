import test from "node:test";
import assert from "node:assert/strict";
import { seal } from "../src/lib/crypto.js";
import {
  clearFcmAuthCacheForTests,
  resolveFcmConfigForTenant,
} from "../src/lib/fcm-config.js";

const sa = {
  client_email: "a@tenant-a.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nA\n-----END PRIVATE KEY-----\n",
};

const saB = {
  client_email: "b@tenant-b.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nB\n-----END PRIVATE KEY-----\n",
};

test("tenant A and B resolve different FCM projects without cross-use", () => {
  clearFcmAuthCacheForTests();
  const tenantA = {
    _id: "tnt_A",
    integrationSecrets: {
      fcm: {
        projectId: "project-a",
        serviceAccountJsonSealed: seal(JSON.stringify(sa)),
        credentialVersion: 1,
      },
    },
  };
  const tenantB = {
    _id: "tnt_B",
    integrationSecrets: {
      fcm: {
        projectId: "project-b",
        serviceAccountJsonSealed: seal(JSON.stringify(saB)),
        credentialVersion: 1,
      },
    },
  };
  const configA = resolveFcmConfigForTenant(tenantA);
  const configB = resolveFcmConfigForTenant(tenantB);
  assert.equal(configA.projectId, "project-a");
  assert.equal(configB.projectId, "project-b");
  assert.notEqual(configA.cacheKey, configB.cacheKey);
  assert.match(configA.cacheKey, /^tnt_A:/);
  assert.match(configB.cacheKey, /^tnt_B:/);
});

test("tenant without FCM does not fall back when shared project disabled", () => {
  clearFcmAuthCacheForTests();
  const config = resolveFcmConfigForTenant({ _id: "tnt_empty", integrationSecrets: {} });
  assert.equal(config, null);
});
