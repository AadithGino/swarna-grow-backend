/**
 * Replace MYDREAM customer home + shop banners with generated hero art.
 *
 *   npm run seed:mydream-banners
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { seedMyDreamDiamondBanners } from "./lib/mydream-banner-seed.js";

async function main() {
  await connectDatabase();
  const result = await seedMyDreamDiamondBanners();
  console.log(JSON.stringify(result, null, 2));
  console.log("\nRefresh /customer/mydream and /customer/mydream/shop to see new banners.");
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});