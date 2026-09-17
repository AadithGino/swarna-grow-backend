import { Counter } from "../models/index.js";

export async function nextSequence(tenantId, name, session) {
  const row = await Counter.findOneAndUpdate({ _id: `${tenantId}:${name}` }, { $inc: { value: 1 } }, { upsert: true, new: true, session, setDefaultsOnInsert: true });
  return row.value;
}

const sequenceBlocks = new Map();
export async function nextSequenceFromBlock(tenantId, name, blockSize = 100) {
  const key = `${tenantId}:${name}`;
  let block = sequenceBlocks.get(key);
  if (!block || block.next > block.end) {
    const row = await Counter.findOneAndUpdate(
      { _id: key },
      { $inc: { value: blockSize } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    block = { next: row.value - blockSize + 1, end: row.value };
    sequenceBlocks.set(key, block);
  }
  const value = block.next;
  block.next += 1;
  return value;
}
