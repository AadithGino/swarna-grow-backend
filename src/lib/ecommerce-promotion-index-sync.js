/**
 * Read-only index preview and explicit apply for ecommerce promotion models.
 */
export function parseEcommercePromotionIndexArgv(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  const apply = argv.includes("--apply");
  if (dryRun && apply) {
    return { error: "CONTRADICTORY_FLAGS" };
  }
  const preview = dryRun || !apply;
  return { preview, apply, dryRun: preview && dryRun, error: null };
}

export async function previewEcommercePromotionIndexes(models) {
  const report = [];
  for (const { name, model } of models) {
    const diff = await model.diffIndexes();
    report.push({
      model: name,
      toCreate: diff.toCreate ?? [],
      toDrop: diff.toDrop ?? [],
    });
  }
  return report;
}

export async function applyEcommercePromotionIndexes(models) {
  const applied = [];
  for (const { name, model } of models) {
    const result = await model.syncIndexes();
    applied.push({ model: name, result });
  }
  return applied;
}
