/** Test-only fault injection for gateway Mongo transaction boundaries (NODE_ENV=test). */
const afterFaults = new Map();

export function clearGatewayTxFaults() {
  afterFaults.clear();
}

export function setGatewayTxFaultAfter(label, error = new Error(`fault:${label}`)) {
  afterFaults.set(label, error);
}

export function gatewayTxFaultCheckpoint(label) {
  const error = afterFaults.get(label);
  if (error) throw error;
}
