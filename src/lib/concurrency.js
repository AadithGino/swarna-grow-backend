/** Run async fn over items with a fixed concurrency limit. */
export async function mapWithConcurrency(items, concurrency, fn) {
  const list = [...items];
  if (!list.length) return [];
  const limit = Math.max(1, Math.min(concurrency, list.length));
  const results = new Array(list.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= list.length) return;
      results[index] = await fn(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
