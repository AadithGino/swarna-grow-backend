import test from "node:test";
import assert from "node:assert/strict";
import { findSandboxPhonePeLiveTenants } from "../src/lib/production-boot-checks.js";

test("findSandboxPhonePeLiveTenants flags live tenants on sandbox PhonePe", () => {
  const tenants = [
    {
      code: "LIVEOK",
      integrationSecrets: { phonepe: { clientId: "a", environment: "PRODUCTION" } },
    },
    {
      code: "LIVEBAD",
      integrationSecrets: { phonepe: { clientId: "b", environment: "SANDBOX" } },
    },
    { code: "NOPAY", integrationSecrets: {} },
  ];
  assert.deepEqual(findSandboxPhonePeLiveTenants(tenants, "PRODUCTION"), ["LIVEBAD"]);
});

test("findSandboxPhonePeLiveTenants inherits platform PHONEPE_ENV when tenant omits environment", () => {
  const tenants = [
    { code: "INHERIT", integrationSecrets: { phonepe: { clientId: "x" } } },
  ];
  assert.deepEqual(findSandboxPhonePeLiveTenants(tenants, "SANDBOX"), ["INHERIT"]);
  assert.deepEqual(findSandboxPhonePeLiveTenants(tenants, "PRODUCTION"), []);
});
