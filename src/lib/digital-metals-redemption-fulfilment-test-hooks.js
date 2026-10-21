/** Test-only hooks for redemption fulfilment HTTP crash simulation (NODE_ENV=test). */
export const redemptionFulfilmentTestHooks = {
  /** When set to an idempotency key, dispatch throws after DB commit (simulates lost HTTP response). */
  dispatchAfterCommitThrowKey: null,
  replacementDispatchAfterCommitThrowKey: null,
};

export function clearRedemptionFulfilmentTestHooksForTests() {
  redemptionFulfilmentTestHooks.dispatchAfterCommitThrowKey = null;
  redemptionFulfilmentTestHooks.replacementDispatchAfterCommitThrowKey = null;
}
