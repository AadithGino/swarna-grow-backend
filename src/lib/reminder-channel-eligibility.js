import {
  pushEnabledForType,
  whatsAppEnabledForType,
} from "./reminder-config.js";

export function evaluateReminderChannels({
  config,
  customer,
  type,
  templateParams = {},
  pushOnly = false,
  pushCountToday = 0,
  whatsAppCountToday = 0,
}) {
  const maxPush = config.maxPushPerCustomerPerDay ?? 3;
  const maxWa = config.maxWhatsAppPerCustomerPerDay ?? 0;
  const whatsapp = !pushOnly
    && !customer?.whatsappOptedOutAt
    && whatsAppEnabledForType(config, type)
    && (maxWa <= 0 || whatsAppCountToday < maxWa);
  const push = pushEnabledForType(config, type, templateParams)
    && (maxPush <= 0 || pushCountToday < maxPush);
  return { whatsapp, push };
}
