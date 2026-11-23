import { invalidatePhonePeClientCache } from "../../src/integrations/phonepe.provider.js";
import { invalidateMessageCentralAuthCache } from "../../src/lib/message-central-credentials.js";
import { Tenant } from "../../src/models/index.js";

function cloneSubdoc(value) {
  if (!value || typeof value !== "object") return undefined;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Copy PhonePe + Message Central credentials from one tenant to another (MongoDB integrationSecrets).
 */
export async function copyTenantIntegrationSecrets({
  sourceCode = "EVOLUXE",
  targetCode,
  preserveTargetEcommerce = true,
} = {}) {
  if (!targetCode) throw new Error("targetCode is required.");

  const source = await Tenant.findOne({ code: sourceCode }).select("+integrationSecrets");
  if (!source) throw new Error(`Source tenant ${sourceCode} not found.`);

  const target = await Tenant.findOne({ code: targetCode }).select("+integrationSecrets");
  if (!target) throw new Error(`Target tenant ${targetCode} not found.`);

  const srcSecrets = source.integrationSecrets ?? {};
  const phonepe = cloneSubdoc(srcSecrets.phonepe);
  const messageCentral = cloneSubdoc(srcSecrets.messageCentral);

  if (!phonepe?.clientId) {
    throw new Error(
      `${sourceCode} has no PhonePe credentials. Run npm run configure:evoluxe-phonepe first.`,
    );
  }

  target.integrationSecrets ??= {};
  target.integrationSecrets.phonepe = phonepe;
  if (messageCentral?.customerId) {
    target.integrationSecrets.messageCentral = messageCentral;
  }

  const ecommerceWasOff = target.operations?.ecommerceEnabled === false;

  target.operations ??= {};
  target.operations.customerAppPaymentsEnabled = source.operations?.customerAppPaymentsEnabled ?? true;
  target.operations.customerAppWriteEnabled = source.operations?.customerAppWriteEnabled ?? true;

  if (preserveTargetEcommerce && ecommerceWasOff) {
    target.operations.ecommerceEnabled = false;
    target.operations.ecommercePaymentsRolloutEnabled = false;
  } else {
    target.operations.ecommerceEnabled = target.operations.ecommerceEnabled ?? source.operations?.ecommerceEnabled ?? true;
    target.operations.ecommercePaymentsRolloutEnabled =
      source.operations?.ecommercePaymentsRolloutEnabled ?? target.operations.ecommercePaymentsRolloutEnabled;
  }

  if (!target.branding?.websiteUrl && source.branding?.websiteUrl) {
    target.branding ??= {};
    target.branding.websiteUrl = source.branding.websiteUrl;
  }

  target.markModified("integrationSecrets");
  target.markModified("operations");
  if (target.branding) target.markModified("branding");
  target.version = Number(target.version ?? 0) + 1;
  await target.save();

  invalidatePhonePeClientCache(target._id);
  if (messageCentral?.customerId) {
    invalidateMessageCentralAuthCache(target._id);
  }

  return {
    targetId: target._id,
    phonepe,
    messageCentral,
    ecommerceWasOff,
  };
}