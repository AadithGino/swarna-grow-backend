import { Customer } from "../models/index.js";
import { errors } from "./app-error.js";

/**
 * Transactional serialization point for one-active-scheme enrolment.
 * Uses enrolmentSerializationVersion — not Customer.version (profile optimistic concurrency).
 */
export async function serializeCustomerEnrolment(session, tenantId, customerId) {
  const customer = await Customer.findOneAndUpdate(
    { _id: customerId, tenantId },
    { $inc: { enrolmentSerializationVersion: 1 } },
    { session, new: true },
  );
  if (!customer) throw errors.notFound("Customer");
  return customer;
}
