import test from "node:test";
import assert from "node:assert/strict";
import { assertIsolatedMongoUri } from "../scripts/lib/isolated-mongo-uri.js";

test("payment UI runner accepts only its dedicated loopback database", () => {
  assert.deepEqual(
    assertIsolatedMongoUri("mongodb://127.0.0.1:27017/swarnagrow_ecommerce_pay_ui?replicaSet=testset"),
    { host: "127.0.0.1", dbName: "swarnagrow_ecommerce_pay_ui" },
  );
  assert.throws(
    () => assertIsolatedMongoUri("mongodb://example.com/swarnagrow_ecommerce_pay_ui"),
    /non-local MongoDB host/,
  );
  assert.throws(
    () => assertIsolatedMongoUri("mongodb://example.com/swarnagrow?origin=127.0.0.1"),
    /non-local MongoDB host/,
  );
  assert.throws(
    () => assertIsolatedMongoUri("mongodb://127.0.0.1:27017/swarnagrow_test"),
    /Refusing database/,
  );
});
