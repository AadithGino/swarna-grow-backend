import { AppError } from "./app-error.js";

export function kycAllowedTypesForTenant(tenant) {
  const ops = tenant?.operations ?? {};
  const allowed = ops.kycAllowedTypes ?? ["AADHAAR", "PAN"];
  return allowed.filter(Boolean);
}

export function assertKycTypeAllowed(tenant, type) {
  const allowed = kycAllowedTypesForTenant(tenant);
  if (!type || !allowed.includes(type)) {
    throw new AppError(
      "KYC_TYPE_NOT_ALLOWED",
      `This jewellery accepts KYC types: ${allowed.join(", ") || "none"}.`,
      422,
      [{ field: "body.type", message: "KYC document type is not allowed for this jewellery." }],
    );
  }
}

/** Resolves ops.kycMandatory and legacy settings.requireKycForEnrolment (tenant-settings parity). */
export function isKycMandatoryForEnrolment(tenant) {
  const ops = tenant?.operations ?? {};
  const settings = tenant?.settings ?? {};
  if (ops.kycMandatory != null) return ops.kycMandatory === true;
  return settings.requireKycForEnrolment === true;
}

/** Customer app self-service KYC is allowed only when KYC is mandatory for the tenant. */
export function isCustomerSelfKycEnabled(tenant) {
  return isKycMandatoryForEnrolment(tenant);
}

export function pickKycSubmitFields(body) {
  const picked = {};
  for (const key of ["type", "number", "numberMasked", "frontUploadId", "backUploadId"]) {
    if (body[key] !== undefined) picked[key] = body[key];
  }
  return picked;
}
