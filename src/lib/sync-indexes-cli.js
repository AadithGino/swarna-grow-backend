/**
 * Pure CLI parsing for operator index rollout (unit-testable).
 */
export function parseSyncIndexArgv(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  const apply = argv.includes("--apply");
  const applyDrops = argv.includes("--apply-drops");
  const operatorConfirmDrops = argv.includes("--operator-confirm-drops");
  const confirmDropNames = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--confirm-drop" && argv[i + 1]) {
      confirmDropNames.push(argv[i + 1]);
      i += 1;
    }
  }
  return {
    dryRun,
    apply,
    applyDrops,
    operatorConfirmDrops,
    confirmDropNames: new Set(confirmDropNames),
  };
}

export function planIndexDrops({ toDrop = [], confirmDropNames = new Set(), applyDrops, operatorConfirmDrops }) {
  const skipped = [];
  const approved = [];
  for (const indexName of toDrop) {
    if (indexName === "_id_") continue;
    if (!applyDrops) {
      skipped.push({ indexName, reason: "APPLY_DROPS_NOT_SET" });
      continue;
    }
    if (!operatorConfirmDrops) {
      skipped.push({ indexName, reason: "OPERATOR_CONFIRM_DROPS_REQUIRED" });
      continue;
    }
    if (!confirmDropNames.has(indexName)) {
      skipped.push({ indexName, reason: "NOT_EXPLICITLY_CONFIRMED" });
      continue;
    }
    approved.push(indexName);
  }
  return { approved, skipped };
}
