import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import * as models from "../src/models/index.js";

await connectDatabase();
try {
  for (const model of Object.values(models)) {
    if (model?.syncIndexes) await model.syncIndexes();
  }
} finally {
  await disconnectDatabase();
  await mongoose.disconnect();
}
