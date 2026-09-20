/**
 * Keyset pagination over schemes — avoids unbounded find().lean().
 */
export async function forEachSchemeBatch({
  model,
  filter,
  projection,
  batchSize = 300,
  sort = { _id: 1 },
  handler,
}) {
  let cursor = null;
  let total = 0;
  for (;;) {
    const query = {
      ...filter,
      ...(cursor ? { _id: { $gt: cursor } } : {}),
    };
    const rows = await model
      .find(query)
      .select(projection)
      .sort(sort)
      .limit(batchSize)
      .lean();
    if (!rows.length) break;
    await handler(rows);
    total += rows.length;
    cursor = rows[rows.length - 1]._id;
    if (rows.length < batchSize) break;
  }
  return total;
}
