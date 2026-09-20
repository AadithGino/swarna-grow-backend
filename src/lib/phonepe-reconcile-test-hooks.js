/** Test-only coordination hooks for reconciliation races (disabled outside NODE_ENV=test). */

function testHooksEnabled() {
  return process.env.NODE_ENV === "test";
}

let pauseBeforeTerminalFailure = null;
let pauseDuringReconcileProgress = null;
let pauseBeforeExhaustionTransition = null;
let pauseBeforeReconcileCore = null;

export function armPauseBeforeTerminalFailure() {
  if (!testHooksEnabled()) {
    throw new Error("reconcile test hooks are only available when NODE_ENV=test");
  }
  let releaseGate = () => {};
  let signalEntered = () => {};
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  pauseBeforeTerminalFailure = async () => {
    signalEntered();
    await gate;
  };
  return {
    waitUntilPaused: () => entered,
    resume: () => releaseGate(),
    disarm: () => {
      pauseBeforeTerminalFailure = null;
    },
  };
}

export function armPauseDuringReconcileProgress() {
  if (!testHooksEnabled()) {
    throw new Error("reconcile test hooks are only available when NODE_ENV=test");
  }
  let releaseGate = () => {};
  let signalEntered = () => {};
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  pauseDuringReconcileProgress = async () => {
    signalEntered();
    await gate;
  };
  return {
    waitUntilPaused: () => entered,
    resume: () => releaseGate(),
    disarm: () => {
      pauseDuringReconcileProgress = null;
    },
  };
}

export function armPauseBeforeExhaustionTransition() {
  if (!testHooksEnabled()) {
    throw new Error("reconcile test hooks are only available when NODE_ENV=test");
  }
  let releaseGate = () => {};
  let signalEntered = () => {};
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  pauseBeforeExhaustionTransition = async () => {
    signalEntered();
    await gate;
  };
  return {
    waitUntilPaused: () => entered,
    resume: () => releaseGate(),
    disarm: () => {
      pauseBeforeExhaustionTransition = null;
    },
  };
}

export function armPauseBeforeReconcileCore() {
  if (!testHooksEnabled()) {
    throw new Error("reconcile test hooks are only available when NODE_ENV=test");
  }
  let releaseGate = () => {};
  let signalEntered = () => {};
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  pauseBeforeReconcileCore = async () => {
    signalEntered();
    await gate;
  };
  return {
    waitUntilPaused: () => entered,
    resume: () => releaseGate(),
    disarm: () => {
      pauseBeforeReconcileCore = null;
    },
  };
}

export function clearReconcileTestHooks() {
  pauseBeforeTerminalFailure = null;
  pauseDuringReconcileProgress = null;
  pauseBeforeExhaustionTransition = null;
  pauseBeforeReconcileCore = null;
}

export async function reconcileTestHookBeforeTerminalFailure() {
  if (!testHooksEnabled() || !pauseBeforeTerminalFailure) return;
  await pauseBeforeTerminalFailure();
}

export async function reconcileTestHookDuringReconcileProgress() {
  if (!testHooksEnabled() || !pauseDuringReconcileProgress) return;
  await pauseDuringReconcileProgress();
}

export async function reconcileTestHookBeforeExhaustionTransition() {
  if (!testHooksEnabled() || !pauseBeforeExhaustionTransition) return;
  await pauseBeforeExhaustionTransition();
}

export async function reconcileTestHookBeforeReconcileCore() {
  if (!testHooksEnabled() || !pauseBeforeReconcileCore) return;
  await pauseBeforeReconcileCore();
}
