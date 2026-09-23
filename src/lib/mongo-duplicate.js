import { AppError } from "./app-error.js";

function duplicateIndexName(error) {
  const msg = String(error?.message ?? "");
  const match = msg.match(/index:\s+(\S+)/i);
  return match?.[1]?.replace(/:$/, "") ?? "";
}

/**
 * Map MongoDB E11000 keyValue to contract-style field errors.
 * Customer indexes: { tenantId, mobile }, { tenantId, customerNumber }, { tenantId, passbookNumber }.
 */
export function appErrorFromDuplicateKey(error) {
  const keyValue = error?.keyValue ?? {};
  const indexName = duplicateIndexName(error);
  const details = [];

  const mobileIndex =
    keyValue.mobile != null ||
    indexName.includes("mobile") ||
    indexName === "tenantId_1_mobile_1";

  if (mobileIndex) {
    details.push({
      field: "body.mobile",
      message:
        "This mobile number is already registered for a customer in this jewellery.",
    });
  }
  if (keyValue.email != null) {
    details.push({
      field: "body.email",
      message:
        "This email is already registered for a customer in this jewellery.",
    });
  }
  if (keyValue.customerNumber != null || indexName.includes("customerNumber")) {
    details.push({
      field: "body.customerNumber",
      message: "This customer ID is already in use.",
    });
  }
  const passbookIndex =
    (keyValue.passbookNumber != null && keyValue.passbookNumber !== "") ||
    (indexName.includes("passbookNumber") && keyValue.passbookNumber != null);

  if (passbookIndex) {
    details.push({
      field: "body.passbookNumber",
      message: "This passbook number is already in use.",
    });
  }

  if (keyValue.code != null || indexName.includes("tenantId_1_code")) {
    details.push({
      field: "body.code",
      message: "This branch code is already in use for this jewellery.",
    });
  }

  if (
    !details.length &&
    indexName.includes("passbookNumber") &&
    keyValue.passbookNumber == null
  ) {
    details.push({
      field: "body.passbookNumber",
      message:
        "Passbook numbering is misconfigured for this jewellery. Contact support or try again after an admin fix.",
    });
  }

  const code = details.some((d) => d.field === "body.mobile")
    ? "CUSTOMER_MOBILE_EXISTS"
    : details.some((d) => d.field === "body.code")
      ? "BRANCH_CODE_EXISTS"
      : details.some((d) => d.field === "body.email")
        ? "CUSTOMER_EMAIL_EXISTS"
        : details.some((d) => d.field === "body.passbookNumber")
          ? "CUSTOMER_PASSBOOK_EXISTS"
          : "DUPLICATE_RESOURCE";

  const message =
    details.length === 1
      ? details[0].message
      : "A record with the same unique value already exists.";

  return new AppError(code, message, 409, details.length ? details : keyValue);
}
