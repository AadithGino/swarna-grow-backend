import { Customer } from "../models/index.js";
import { errors } from "./app-error.js";

/**
 * Transactional serialization point for one-active-scheme enrolment.
 * Atomic customer version bump — no stuck lock flag.
 */
export async function serializeCustomerEnrolment(session, tenantId, customerId) {
  const customer = await Customer.findOneAndUpdate(
    { _id: customerId, tenantId },
    { $inc: { version: 1 } },
    { session, new: true },
  );
  if (!customer) throw errors.notFound("Customer");
  return customer;
}
