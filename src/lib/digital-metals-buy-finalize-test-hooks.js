let pauseBeforeBuyCredit = false;

export function armPauseBeforeDigitalMetalBuyCreditForTests() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Test hooks require NODE_ENV=test");
  }
  pauseBeforeBuyCredit = true;
}

export function clearDigitalMetalBuyFinalizeTestHooksForTests() {
  pauseBeforeBuyCredit = false;
}

export async function maybePauseBeforeDigitalMetalBuyCreditForTests() {
  if (pauseBeforeBuyCredit) {
    throw new Error("TEST_PAUSE_BEFORE_BUY_CREDIT");
  }
}
