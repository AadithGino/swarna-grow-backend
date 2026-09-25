import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { CashHandover } from "../src/models/index.js";
await connectDatabase();
const rows = await CashHandover.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
console.log(rows);
await disconnectDatabase();
