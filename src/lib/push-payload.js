import { MessageType } from "../constants/enums.js";
import { moneyRef } from "./money.js";

function planLabel(scheme) {
  return (
    scheme?.planSnapshot?.displayName
    ?? scheme?.planSnapshot?.name
    ?? scheme?.enrollmentNumber
    ?? "your scheme"
  );
}

/** Build FCM notification title/body/data for a queued message row. */
export function buildPushPayload({ message, scheme, payment, tenant }) {
  const jeweller = tenant?.displayName ?? tenant?.name ?? "Your jeweller";
  const label = planLabel(scheme);
  const enr = scheme?.enrollmentNumber;
  const type = message.type;
  let title = "Update from your jeweller";
  let body = "Tap to view details in the app.";
  let deepLink = scheme?._id ? `/schemes/${scheme._id}` : "/home";

  switch (type) {
    case MessageType.PAYMENT_SUCCESS: {
      const amount = payment ? moneyRef(payment.amountPaise).amountDisplay : null;
      title = "Payment received";
      body = amount
        ? `${amount} was credited to ${label}${enr ? ` (${enr})` : ""}.`
        : `Your payment to ${label} was successful.`;
      if (payment?._id) deepLink = `/payments/${payment._id}`;
      break;
    }
    case MessageType.PAYMENT_DUE:
      title = message.templateParams?.pushKind === "FLEX_NUDGE"
        ? "Contribution reminder"
        : "Instalment due";
      body = enr
        ? `Your next instalment for ${label} (${enr}) is due. Pay securely from the app.`
        : `Your next instalment for ${label} is due. Pay securely from the app.`;
      if (scheme?._id) deepLink = `/schemes/${scheme._id}`;
      break;
    case MessageType.PAYMENT_OVERDUE:
      title = "Payment overdue";
      body = enr
        ? `An instalment for ${label} (${enr}) is overdue. Please pay at your earliest convenience.`
        : `An instalment for ${label} is overdue. Please pay at your earliest convenience.`;
      if (scheme?._id) deepLink = `/schemes/${scheme._id}`;
      break;
    case MessageType.SCHEME_JOINED:
      title = "Scheme enrolled";
      body = enr
        ? `You are enrolled in ${label}. Your scheme number is ${enr}.`
        : `You are enrolled in ${label}.`;
      break;
    case MessageType.SCHEME_MATURED:
      title = "Scheme matured";
      body = `${label} has reached maturity. View your scheme for redemption options.`;
      break;
    case MessageType.SCHEME_CLOSED:
      title = "Scheme closed";
      body = `${label} is now closed. Your passbook and receipts remain available in the app.`;
      break;
    case MessageType.FLEXI_LOCK_APPLIED:
      title = "Monthly cap locked";
      body = `Your flexible phase has ended and your monthly cap for ${label} is now locked.`;
      break;
    case MessageType.MANUAL_PUSH:
      title = String(message.templateParams?.title ?? title);
      body = String(message.templateParams?.body ?? body);
      deepLink = String(message.templateParams?.deepLink ?? "/home");
      break;
    default:
      break;
  }

  return {
    title,
    body,
    data: {
      messageId: message._id,
      messageType: type,
      schemeId: scheme?._id ?? message.schemeId ?? "",
      paymentId: payment?._id ?? message.templateParams?.paymentId ?? "",
      deepLink,
      jewellerName: jeweller,
    },
  };
}
