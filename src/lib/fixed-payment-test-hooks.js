function enabled() {
  return process.env.NODE_ENV === "test";
}

let pauseBeforeManualFixedReservationGate = null;
let pauseBeforeFixedSchemeCommit = null;
let pauseBeforeGatewayRecordPayment = null;
const pendingGateReleases = [];

function makeGate() {
  let releaseGate = () => {};
  let signalEntered = () => {};
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  pendingGateReleases.push(releaseGate);
  return {
    waitUntilPaused: () => entered,
    resume: () => releaseGate(),
    async pause() {
      signalEntered();
      await gate;
    },
  };
}

export function armPauseBeforeManualFixedReservationGate() {
  if (!enabled()) throw new Error("fixed payment test hooks require NODE_ENV=test");
  const gate = makeGate();
  pauseBeforeManualFixedReservationGate = gate.pause.bind(gate);
  return {
    waitUntilPaused: gate.waitUntilPaused,
    resume: gate.resume,
    disarm: () => {
      pauseBeforeManualFixedReservationGate = null;
    },
  };
}

export function armPauseBeforeFixedSchemeCommit() {
  if (!enabled()) throw new Error("fixed payment test hooks require NODE_ENV=test");
  const gate = makeGate();
  pauseBeforeFixedSchemeCommit = gate.pause.bind(gate);
  return {
    waitUntilPaused: gate.waitUntilPaused,
    resume: gate.resume,
    disarm: () => {
      pauseBeforeFixedSchemeCommit = null;
    },
  };
}

export function armPauseBeforeGatewayRecordPayment() {
  if (!enabled()) throw new Error("fixed payment test hooks require NODE_ENV=test");
  const gate = makeGate();
  pauseBeforeGatewayRecordPayment = gate.pause.bind(gate);
  return {
    waitUntilPaused: gate.waitUntilPaused,
    resume: gate.resume,
    disarm: () => {
      pauseBeforeGatewayRecordPayment = null;
    },
  };
}

/** Release any armed barrier and clear hook state (test teardown). */
export function clearFixedPaymentTestHooks() {
  while (pendingGateReleases.length) {
    const release = pendingGateReleases.pop();
    release();
  }
  pauseBeforeManualFixedReservationGate = null;
  pauseBeforeFixedSchemeCommit = null;
  pauseBeforeGatewayRecordPayment = null;
}

export async function fixedPaymentTestHookBeforeManualFixedReservationGate() {
  if (!enabled() || !pauseBeforeManualFixedReservationGate) return;
  await pauseBeforeManualFixedReservationGate();
}

export async function fixedPaymentTestHookBeforeFixedSchemeCommit() {
  if (!enabled() || !pauseBeforeFixedSchemeCommit) return;
  await pauseBeforeFixedSchemeCommit();
}

export async function fixedPaymentTestHookBeforeGatewayRecordPayment() {
  if (!enabled() || !pauseBeforeGatewayRecordPayment) return;
  await pauseBeforeGatewayRecordPayment();
}
