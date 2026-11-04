/** Recover persisted attempts even when provider initiation lost its response. */
export function checkoutReconcileFilter({ at, cutoff, maxAttempts }) {
  return {
    status: { $in: ["PENDING", "INITIATED"] },
    $and: [
      { $or: [{ gatewayReconcileAttempts: { $lt: maxAttempts } }, { gatewayReconcileAttempts: null }] },
      { $or: [
        { gatewayReconcileNextAt: { $lte: at } },
        { gatewayReconcileNextAt: null, updatedAt: { $lte: cutoff } },
      ] },
    ],
  };
}
