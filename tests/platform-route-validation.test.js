import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assertPlatformMutationRegistry } from "../src/lib/platform-mutation-registry.js";
import { platformRouteValidators } from "../src/validators/platform.validators.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const routesSource = readFileSync(join(root, "src/routes/platform.routes.js"), "utf8");

test("platform mutation registry stays aligned with platform.routes.js", () => {
  const { routeCount } = assertPlatformMutationRegistry({
    routesSource,
    validators: platformRouteValidators,
  });
  assert.equal(routeCount, 27);
});
