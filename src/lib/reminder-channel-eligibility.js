import { pushEnabledForType } from "./reminder-config.js";

export function evaluateReminderChannels({
  config,
  type,
  templateParams = {},
  pushOnly = false,
  pushCountToday = 0,
}) {
  const maxPush = config.maxPushPerCustomerPerDay ?? 3;
  const whatsapp = false;
  const push = pushEnabledForType(config, type, templateParams)
    && (maxPush <= 0 || pushCountToday < maxPush);
  if (pushOnly && !push) return { whatsapp: false, push: false };
  return { whatsapp, push };
}
