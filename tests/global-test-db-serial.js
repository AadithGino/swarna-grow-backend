/**
 * Serializes every test in the process so shared Mongo resetTestDb() cannot
 * interleave across sibling tests (Node runs top-level tests in parallel by default).
 */
import { after, afterEach, before, beforeEach } from "node:test";
import { disableEcommercePaymentsTestHarness } from "./helpers/ecommerce-checkout-fixtures.js";
import { startTestDb, stopTestDb } from "./helpers/db.js";

const hookOpts = { scope: "global" };

let turn = Promise.resolve();
let releaseTurn = () => {};

beforeEach(async () => {
  await turn;
  turn = new Promise((resolve) => {
    releaseTurn = resolve;
  });
}, hookOpts);

afterEach(() => {
  disableEcommercePaymentsTestHarness();
  releaseTurn();
}, hookOpts);

before(async () => {
  await startTestDb();
}, hookOpts);

after(async () => {
  await stopTestDb({ force: true });
}, hookOpts);
