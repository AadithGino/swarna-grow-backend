import { EcommerceCustomerAddress } from "../../src/models/ecommerce-commerce.models.js";
import { createId } from "../../src/lib/ids.js";

/** Customer-owned delivery address required for DELIVERY redemption quotes. */
export async function seedCustomerDeliveryAddress({
  tenantId,
  customerId,
  addressId = createId("eaddr"),
}) {
  await EcommerceCustomerAddress.create({
    _id: addressId,
    tenantId,
    customerId,
    label: "Home",
    recipientName: "Test Customer",
    mobile: "9847000000",
    line1: "1 Test Lane",
    city: "Kochi",
    state: "Kerala",
    pincode: "682001",
    isDefault: true,
  });
  return addressId;
}
