import { Customer, User } from "../models/index.js";

export async function bumpSecurityVersion({ userId, customerId, session } = {}) {
  if (userId) {
    await User.updateOne({ _id: userId }, { $inc: { securityVersion: 1 } }).session(session ?? null);
  }
  if (customerId) {
    await Customer.updateOne({ _id: customerId }, { $inc: { securityVersion: 1 } }).session(session ?? null);
  }
}
