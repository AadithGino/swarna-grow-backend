import "dotenv/config";
import mongoose from "mongoose";
import { Customer } from "../src/models/index.js";

async function run() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI is required.");
  }
  await mongoose.connect(mongoUri);
  const result = await Customer.updateMany(
    {},
    {
      $unset: {
        dateOfBirth: "",
        "nominee.dateOfBirth": "",
      },
    },
  );
  console.log(`Matched ${result.matchedCount} customers; cleaned ${result.modifiedCount} documents.`);
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
