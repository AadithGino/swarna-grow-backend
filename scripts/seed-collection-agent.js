/**
 * Upsert demo collection agent only (no full demo re-seed).
 *
 * Usage: npm run seed:collection-agent
 * Login: tenant KAIRALI · mobile 9847012352 · password 2026 (KOC branch)
 */
import argon2 from "argon2";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { TenantRole, UserStatus, UserType } from "../src/constants/enums.js";
import { ROLE_PERMISSIONS } from "../src/constants/permissions.js";
import { createId } from "../src/lib/ids.js";
import { Branch, Tenant, User } from "../src/models/index.js";

const TENANT_CODE = process.env.DEMO_TENANT_CODE ?? "KAIRALI";
const BRANCH_CODE = process.env.DEMO_COLLECTOR_BRANCH_CODE ?? "KOC";
const MOBILE = process.env.DEMO_COLLECTOR_MOBILE ?? "9847012352";
const PASSWORD = process.env.DEMO_COLLECTOR_PASSWORD ?? process.env.DEMO_OWNER_PASSWORD ?? "2026";
const NAME = process.env.DEMO_COLLECTOR_NAME ?? "Vijay Field";

async function main() {
  await connectDatabase();

  const tenant = await Tenant.findOne({ code: TENANT_CODE }).lean();
  if (!tenant) {
    throw new Error(`Tenant not found: ${TENANT_CODE}. Run seed:demo once or create tenant first.`);
  }

  const branch = await Branch.findOne({ tenantId: tenant._id, code: BRANCH_CODE, active: true }).lean();
  if (!branch) {
    throw new Error(`Branch ${BRANCH_CODE} not found for ${TENANT_CODE}.`);
  }

  const passwordHash = await argon2.hash(PASSWORD);
  const permissions = ROLE_PERMISSIONS[TenantRole.COLLECTION_AGENT];

  const existing = await User.findOne({
    tenantId: tenant._id,
    mobile: MOBILE,
    type: UserType.TENANT_USER,
  });

  if (existing) {
    existing.role = TenantRole.COLLECTION_AGENT;
    existing.branchId = branch._id;
    existing.name = NAME;
    existing.passwordHash = passwordHash;
    existing.status = UserStatus.ACTIVE;
    existing.permissions = permissions;
    await existing.save();
    process.stdout.write(
      `Updated collection agent ${MOBILE} (${NAME}) on ${TENANT_CODE}/${BRANCH_CODE}\n`,
    );
  } else {
    await User.create({
      _id: createId("user"),
      type: UserType.TENANT_USER,
      tenantId: tenant._id,
      branchId: branch._id,
      role: TenantRole.COLLECTION_AGENT,
      name: NAME,
      mobile: MOBILE,
      passwordHash,
      status: UserStatus.ACTIVE,
      permissions,
    });
    process.stdout.write(
      `Created collection agent ${MOBILE} (${NAME}) on ${TENANT_CODE}/${BRANCH_CODE}\n`,
    );
  }

  process.stdout.write(`Password: ${PASSWORD}\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
