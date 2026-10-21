/**
 * Runs one digital-metals outbox dispatch pass (dev DB). Used during browser smoke when scheduler is idle.
 * Run: node --env-file=.env scripts/digital-metals-outbox-dispatch-once.js
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { runDigitalMetalOutboxDispatch } from "../src/services/digital-metals-outbox-dispatch.service.js";

await connectDatabase();
const summary = await runDigitalMetalOutboxDispatch();
process.stdout.write(`digital-metals outbox dispatch: ${JSON.stringify(summary)}\n`);
await disconnectDatabase();
