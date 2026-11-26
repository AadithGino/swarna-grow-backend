import { MessageType } from "../constants/enums.js";
import { queueEcommerceCustomerNotice } from "./ecommerce-outbox-processor.js";
import { moneyRef } from "./money.js";
import { EcommerceBooking } from "../models/index.js";

const deepLink = (bookingId) => `/shop/booking/${bookingId}`;
const rupees = (paise) => moneyRef(paise).amountDisplay;

async function queue(booking, key, title, body) {
  return queueEcommerceCustomerNotice({
    tenantId: booking.tenantId,
    branchId: booking.pickupBranchId,
    customerId: booking.customerId,
    type: MessageType.ECOMMERCE_BOOKING_UPDATE,
    inboxEventKey: `ecommerce.booking.${key}:${booking._id}`,
    booking,
    title,
    body,
    deepLink: deepLink(booking._id),
  });
}

export async function notifyBookingAdvanceConfirmed(tenantId, bookingId) {
  const booking = await EcommerceBooking.findOne({ _id: bookingId, tenantId }).lean();
  if (!booking) return null;
  return queue(booking, "advance-confirmed", "Your piece is reserved", `We received your advance of ${rupees(booking.advance?.capturedPaise)} for ${booking.productName}. The store will bill the final price when it is ready.`);
}

export async function notifyBookingBalanceReady(bookingRow) {
  const b = bookingRow;
  const amount = b.finalBilling?.balancePaise != null ? ` Pay ${rupees(b.finalBilling.balancePaise)}` : "";
  const by = b.balanceDueAt ? ` by ${new Date(b.balanceDueAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : "";
  return queue(b, "balance-ready", "Pay the balance for your booking", `Your booking ${b.bookingNumber} for ${b.productName} is ready to complete.${amount}${by}.`);
}

export async function notifyBookingConverted(bookingRow, orderNumber) {
  const b = bookingRow;
  const label = orderNumber ? `Order ${orderNumber}` : "Your order";
  return queue(b, "converted", "Booking complete — order placed", `${label} is placed for ${b.productName}. You will hear from the store when your piece is ready to collect.`);
}
