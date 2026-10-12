import test from "node:test";
import assert from "node:assert/strict";
import { validateCodPincodeConfiguration } from "../src/lib/ecommerce-cod.js";

test("validateCodPincodeConfiguration rejects pin outside serviceable", () => {
  const r = validateCodPincodeConfiguration({
    codEnabled: true,
    codPincodes: ["686692"],
    serviceablePincodes: ["682001"],
  });
  assert.equal(r.ok, false);
});

test("validateCodPincodeConfiguration accepts subset", () => {
  const r = validateCodPincodeConfiguration({
    codEnabled: true,
    codPincodes: ["682001"],
    serviceablePincodes: ["682001", "686692"],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.normalized, ["682001"]);
});
