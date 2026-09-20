function testHooksEnabled() {
  return process.env.NODE_ENV === "test";
}

let pauseBeforeFcmSend = null;
let pauseBeforeApplyPushOutcome = null;

export function armPauseBeforeFcmSend() {
  if (!testHooksEnabled()) {
    throw new Error("FCM push test hooks are only available when NODE_ENV=test");
  }
  let releaseGate = () => {};
  let signalEntered = () => {};
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  pauseBeforeFcmSend = async () => {
    signalEntered();
    await gate;
  };
  return {
    waitUntilPaused: () => entered,
    resume: () => releaseGate(),
    disarm: () => {
      pauseBeforeFcmSend = null;
    },
  };
}

export function armPauseBeforeApplyPushOutcome() {
  if (!testHooksEnabled()) {
    throw new Error("FCM push test hooks are only available when NODE_ENV=test");
  }
  let releaseGate = () => {};
  let signalEntered = () => {};
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  pauseBeforeApplyPushOutcome = async () => {
    signalEntered();
    await gate;
  };
  return {
    waitUntilPaused: () => entered,
    resume: () => releaseGate(),
    disarm: () => {
      pauseBeforeApplyPushOutcome = null;
    },
  };
}

export function clearFcmPushTestHooks() {
  pauseBeforeFcmSend = null;
  pauseBeforeApplyPushOutcome = null;
}

export async function fcmPushTestHookBeforeSend() {
  if (!testHooksEnabled() || !pauseBeforeFcmSend) return;
  await pauseBeforeFcmSend();
}

export async function fcmPushTestHookBeforeApplyPushOutcome() {
  if (!testHooksEnabled() || !pauseBeforeApplyPushOutcome) return;
  await pauseBeforeApplyPushOutcome();
}
