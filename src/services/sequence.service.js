import { Counter, LedgerEntry, Scheme } from "../models/index.js";

export async function nextSequence(tenantId, name, session) {
  const row = await Counter.findOneAndUpdate({ _id: `${tenantId}:${name}` }, { $inc: { value: 1 } }, { upsert: true, new: true, session, setDefaultsOnInsert: true });
  return row.value;
}

/**
 * Atomically allocates the next ledger sequence for a scheme (must run inside a transaction).
 * Serializes on the scheme document so concurrent writers cannot receive the same sequence.
 */
export async function nextSchemeLedgerSequence(tenantId, schemeId, session) {
  if (!session) {
    throw new Error("nextSchemeLedgerSequence requires a MongoDB session");
  }
  const maxRow = await LedgerEntry.findOne({ tenantId, schemeId })
    .sort({ sequence: -1 })
    .select("sequence")
    .session(session)
    .lean();
  const ledgerMax = maxRow?.sequence ?? 0;
  if (ledgerMax > 0) {
    await Scheme.updateOne(
      {
        _id: schemeId,
        tenantId,
        $or: [
          { ledgerNextSequence: { $exists: false } },
          { ledgerNextSequence: { $lt: ledgerMax } },
        ],
      },
      { $set: { ledgerNextSequence: ledgerMax } },
      { session },
    );
  }
  const updated = await Scheme.findOneAndUpdate(
    { _id: schemeId, tenantId },
    { $inc: { ledgerNextSequence: 1 } },
    { session, new: true },
  );
  if (!updated) throw new Error("Scheme not found for ledger sequence allocation");
  return updated.ledgerNextSequence;
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
