/** Unified one-active-scheme policy (ops.multiSchemePerCustomer vs legacy settings). */
export function isOneActiveSchemePerCustomerEnforced(tenant) {
  const ops = tenant?.operations ?? {};
  const settings = tenant?.settings ?? {};
  if (ops.multiSchemePerCustomer != null) {
    return ops.multiSchemePerCustomer === false;
  }
  return settings.oneActiveSchemePerCustomer === true;
}
