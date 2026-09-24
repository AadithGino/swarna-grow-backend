import { AppError } from "./app-error.js";

export function customerAppMaintenanceEnabled(tenant) {
  return tenant?.settings?.customerAppMaintenance === true;
}

export function assertCustomerAppAvailable(tenant) {
  if (!customerAppMaintenanceEnabled(tenant)) return;
  throw new AppError(
    "APP_MAINTENANCE",
    "The customer app is temporarily unavailable for maintenance. Please try again later.",
    503,
  );
}

export function customerAppWriteEnabled(tenant) {
  return tenant?.operations?.customerAppWriteEnabled !== false;
}

export function customerAppPaymentsEnabled(tenant) {
  return customerAppWriteEnabled(tenant) && tenant?.operations?.customerAppPaymentsEnabled !== false;
}

export function assertCustomerAppWritable(tenant) {
  if (customerAppWriteEnabled(tenant)) return;
  throw new AppError(
    "CUSTOMER_APP_VIEW_ONLY",
    "This customer app is currently in view-only mode. Contact your jeweller for assistance.",
    403,
  );
}

export function assertCustomerPaymentsEnabled(tenant) {
  if (customerAppPaymentsEnabled(tenant)) return;
  throw new AppError(
    "CUSTOMER_PAYMENTS_DISABLED",
    "Online customer payments are currently unavailable. Contact your branch to continue.",
    403,
  );
}
