/** @internal Test-only dispatch fault injection (NODE_ENV=test). */

function hooksActive() {
  return process.env.NODE_ENV === "test";
}

export const dispatchTestHooks = {
  pauseAfterClaimBeforeQueue: false,
  pauseAfterQueueBeforeAck: false,
  throwOnQueueAdd: false,
};

export function resetDispatchTestHooksForTests() {
  dispatchTestHooks.pauseAfterClaimBeforeQueue = false;
  dispatchTestHooks.pauseAfterQueueBeforeAck = false;
  dispatchTestHooks.throwOnQueueAdd = false;
}

export function readDispatchPauseAfterClaim() {
  return hooksActive() && dispatchTestHooks.pauseAfterClaimBeforeQueue;
}

export function readDispatchPauseAfterQueue() {
  return hooksActive() && dispatchTestHooks.pauseAfterQueueBeforeAck;
}

export function readDispatchThrowOnQueueAdd() {
  return hooksActive() && dispatchTestHooks.throwOnQueueAdd;
}
