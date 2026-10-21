export function mapAdminCustomerBrief(customer) {
  if (!customer) return null;
  return {
    id: customer._id,
    name: customer.name,
    mobile: customer.mobile,
    email: customer.email ?? null,
    customerNumber: customer.customerNumber,
    branchId: customer.branchId ?? null,
  };
}
