let pauseAfterSellDebitBeforePayable = false;

export function armPauseAfterDigitalMetalSellDebitForTests() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Test hooks require NODE_ENV=test");
  }
  pauseAfterSellDebitBeforePayable = true;
}

export function clearDigitalMetalSellFinalizeTestHooksForTests() {
  pauseAfterSellDebitBeforePayable = false;
}

export async function maybePauseAfterDigitalMetalSellDebitForTests() {
  if (pauseAfterSellDebitBeforePayable) {
    throw new Error("TEST_PAUSE_AFTER_SELL_DEBIT");
  }
}
