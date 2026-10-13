/**
 * Serializes every test in the process so shared Mongo resetTestDb() cannot
 * interleave across sibling tests (Node runs top-level tests in parallel by default).
 */
import { afterEach, beforeEach } from "node:test";

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
  releaseTurn();
}, hookOpts);
