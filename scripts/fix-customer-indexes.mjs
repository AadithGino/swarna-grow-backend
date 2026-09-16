/**
 * One-time dev helper: drop legacy passbook sparse index that collided on null.
 * Run: node scripts/fix-customer-indexes.mjs
 * Requires MONGODB_URI (same as the API).
 */
import mongoose from "mongoose";
import { env } from "../src/config/env.js";

await mongoose.connect(env.MONGODB_URI);
const coll = mongoose.connection.collection("customers");
try {
  await coll.dropIndex("tenantId_1_passbookNumber_1");
  console.log("Dropped tenantId_1_passbookNumber_1");
} catch (error) {
  console.warn("Index drop skipped:", error.message);
}
await mongoose.disconnect();
