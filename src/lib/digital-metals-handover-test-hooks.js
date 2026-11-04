let beforeCommit = null;
export function setBeforeDigitalMetalHandoverForTests(callback) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test hooks require NODE_ENV=test');
  beforeCommit = callback;
}
export function clearDigitalMetalHandoverTestHook() { beforeCommit = null; }
export async function beforeDigitalMetalHandoverForTests() {
  if (process.env.NODE_ENV === 'test' && beforeCommit) await beforeCommit();
}
