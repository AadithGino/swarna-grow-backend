import { Counter } from "../models/index.js";

export async function nextSequence(tenantId, name, session) {
  const row = await Counter.findOneAndUpdate({ _id: `${tenantId}:${name}` }, { $inc: { value: 1 } }, { upsert: true, new: true, session, setDefaultsOnInsert: true });
  return row.value;
}

