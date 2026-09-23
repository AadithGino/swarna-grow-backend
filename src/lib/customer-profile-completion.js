import { errors } from "./app-error.js";

export function normalizeCustomerAddress(address) {
  if (address == null) return undefined;
  if (typeof address === "string") {
    const trimmed = address.trim();
    return trimmed || undefined;
  }
  if (typeof address === "object") {
    const line1 = String(address.line1 ?? "").trim();
    if (!line1) return undefined;
    const parts = [line1, address.line2, address.city, address.state, address.pincode]
      .map((part) => (part == null ? "" : String(part).trim()))
      .filter(Boolean);
    return parts.join(", ");
  }
  return undefined;
}

export function hasNonEmptyCustomerAddress(address) {
  if (address == null) return false;
  if (typeof address === "string") return address.trim().length >= 3;
  if (typeof address === "object") {
    return String(address.line1 ?? "").trim().length >= 1;
  }
  return false;
}

export function customerHasRequiredProfileFields(customer) {
  if (!customer) return false;
  const name = String(customer.name ?? "").trim();
  if (name.length < 2 || name === "Customer") return false;
  if (!String(customer.mobile ?? "").trim()) return false;
  if (!hasNonEmptyCustomerAddress(customer.address)) return false;
  if (!customer.branchId) return false;
  return true;
}

export function assertCustomerProfileCompleteFields(customer) {
  const issues = [];
  const name = String(customer?.name ?? "").trim();
  if (name.length < 2 || name === "Customer") {
    issues.push({ field: "body.name", message: "Name is required (min 2 characters)." });
  }
  if (!hasNonEmptyCustomerAddress(customer?.address)) {
    issues.push({ field: "body.address", message: "Address is required." });
  }
  if (!customer?.branchId) {
    issues.push({ field: "branchId", message: "Branch assignment is required to complete profile." });
  }
  if (issues.length) {
    throw errors.validation(issues);
  }
}

export function mergeCustomerProfileFields(customer, body) {
  const next = {
    name: customer.name,
    email: customer.email,
    address: customer.address,
    branchId: customer.branchId,
    mobile: customer.mobile,
  };
  if (body.name !== undefined) next.name = String(body.name).trim();
  if (body.email !== undefined) {
    const email = String(body.email ?? "").trim();
    next.email = email || undefined;
  }
  if (body.address !== undefined) {
    next.address = normalizeCustomerAddress(body.address);
  }
  return next;
}

export function profileCompletionUpdateOps(customer, mergedFields) {
  const draft = { ...customer, ...mergedFields };
  const $set = {};
  const $unset = {};
  for (const key of ["name", "email", "address"]) {
    if (mergedFields[key] !== undefined) $set[key] = mergedFields[key];
  }
  if (customerHasRequiredProfileFields(draft)) {
    if (!customer.profileCompletedAt) {
      $set.profileCompletedAt = new Date();
    }
  } else if (customer.profileCompletedAt) {
    $unset.profileCompletedAt = 1;
  }
  return { $set, $unset };
}
