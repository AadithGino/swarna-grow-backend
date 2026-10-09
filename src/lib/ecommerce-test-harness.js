/** Server-side test harness — never enabled via client headers. */
export function isEcommercePaymentsTestHarnessEnabled() {
  return (
    process.env.NODE_ENV === "test"
    && String(process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS ?? "").toLowerCase() === "true"
  );
}

export function allowTestCustomerOrderCreate() {
  return isEcommercePaymentsTestHarnessEnabled();
}

export function allowTestEcommercePayments() {
  return isEcommercePaymentsTestHarnessEnabled();
}
