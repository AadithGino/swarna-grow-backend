const checkpoints = new Set();

export function clearRefundInitiationTestHooks() {
  checkpoints.clear();
}

export function refundInitiationTestCheckpoint(name) {
  checkpoints.add(name);
}

export function refundInitiationTestCheckpoints() {
  return new Set(checkpoints);
}

export function assertRefundInitiationCheckpoint(name) {
  return checkpoints.has(name);
}
