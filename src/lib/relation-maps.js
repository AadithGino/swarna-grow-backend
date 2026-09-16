import { Branch, Customer, User } from "../models/index.js";

export async function loadBranchMap(tenantId, branchIds) {
  const ids = [...new Set(branchIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await Branch.find({ tenantId, _id: { $in: ids } })
    .select("_id name code")
    .lean();
  return new Map(rows.map((row) => [row._id, row]));
}

export function branchDto(branch) {
  if (!branch) return undefined;
  return {
    _id: branch._id,
    id: branch._id,
    name: branch.name,
    code: branch.code,
  };
}

export async function loadUserMap(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await User.find({ _id: { $in: ids } })
    .select("_id name role mobile")
    .lean();
  return new Map(rows.map((row) => [row._id, row]));
}

export function userDto(user) {
  if (!user) return undefined;
  return {
    _id: user._id,
    id: user._id,
    name: user.name,
    role: user.role,
    mobile: user.mobile,
  };
}

export async function loadCustomerMap(tenantId, customerIds) {
  const ids = [...new Set(customerIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await Customer.find({ tenantId, _id: { $in: ids } })
    .select("_id name mobile customerNumber")
    .lean();
  return new Map(rows.map((row) => [row._id, row]));
}

export function customerDto(customer) {
  if (!customer) return undefined;
  return {
    _id: customer._id,
    id: customer._id,
    name: customer.name,
    mobile: customer.mobile,
    customerNumber: customer.customerNumber,
  };
}
