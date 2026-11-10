import { presentDigitalMetalsAccessState } from "../lib/digital-metals-access.js";
import { AppError, errors } from "../lib/app-error.js";
import { createId } from "../lib/ids.js";
import { withTransaction } from "../lib/transaction.js";
import {
  loadOwnedCustomerDeliveryAddress,
  mapCustomerDeliveryAddress,
} from "../lib/customer-delivery-address.js";
import { EcommerceCustomerAddress } from "../models/ecommerce-commerce.models.js";
import { attachSubscriptionCatalogPlan } from "../lib/subscription-plan-for-tenant.js";
import { Tenant } from "../models/index.js";

async function loadTenant(req) {
  return req.tenant ?? attachSubscriptionCatalogPlan(await Tenant.findById(req.auth.tenantId).lean());
}

function assertDigitalMetalsCustomerActive(tenant) {
  const access = presentDigitalMetalsAccessState(tenant);
  if (!access.active) {
    throw new AppError(
      access.paused ? "DIGITAL_METALS_PAUSED" : "DIGITAL_METALS_DISABLED",
      access.paused ? "Digital metals trading is paused." : "Digital metals is not available.",
      403,
    );
  }
}

export async function listCustomerDigitalMetalsDeliveryAddresses(req) {
  assertDigitalMetalsCustomerActive(await loadTenant(req));
  const rows = await EcommerceCustomerAddress.find({
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  })
    .sort({ isDefault: -1, updatedAt: -1 })
    .lean();
  return { items: rows.map(mapCustomerDeliveryAddress) };
}

export async function createCustomerDigitalMetalsDeliveryAddress(req) {
  assertDigitalMetalsCustomerActive(await loadTenant(req));
  return withTransaction(async (session) => {
    if (req.body.isDefault === true) {
      await EcommerceCustomerAddress.updateMany(
        { tenantId: req.auth.tenantId, customerId: req.auth.id },
        { $set: { isDefault: false } },
        { session },
      );
    }
    const row = (
      await EcommerceCustomerAddress.create(
        [
          {
            _id: createId("eaddr"),
            tenantId: req.auth.tenantId,
            customerId: req.auth.id,
            label: req.body.label ?? "Home",
            recipientName: req.body.recipientName ?? "",
            mobile: req.body.mobile ?? "",
            line1: req.body.line1,
            line2: req.body.line2 ?? "",
            city: req.body.city,
            state: req.body.state,
            pincode: req.body.pincode,
            isDefault: req.body.isDefault === true,
          },
        ],
        { session },
      )
    )[0];
    return mapCustomerDeliveryAddress(row.toObject());
  });
}

export async function patchCustomerDigitalMetalsDeliveryAddress(req) {
  assertDigitalMetalsCustomerActive(await loadTenant(req));
  return withTransaction(async (session) => {
    const row = await EcommerceCustomerAddress.findOne({
      _id: req.params.addressId,
      tenantId: req.auth.tenantId,
      customerId: req.auth.id,
    }).session(session);
    if (!row) throw errors.notFound("Address");
    if (req.body.expectedVersion != null && row.version !== Number(req.body.expectedVersion)) {
      throw errors.conflict("VERSION_CONFLICT", "Address changed elsewhere.");
    }
    if (req.body.isDefault === true) {
      await EcommerceCustomerAddress.updateMany(
        { tenantId: req.auth.tenantId, customerId: req.auth.id, _id: { $ne: row._id } },
        { $set: { isDefault: false } },
        { session },
      );
    }
    const patch = { ...req.body };
    delete patch.expectedVersion;
    Object.assign(row, patch);
    row.version += 1;
    await row.save({ session });
    return mapCustomerDeliveryAddress(row.toObject());
  });
}

export async function deleteCustomerDigitalMetalsDeliveryAddress(req) {
  assertDigitalMetalsCustomerActive(await loadTenant(req));
  return withTransaction(async (session) => {
    const row = await EcommerceCustomerAddress.findOne({
      _id: req.params.addressId,
      tenantId: req.auth.tenantId,
      customerId: req.auth.id,
    }).session(session);
    if (!row) throw errors.notFound("Address");
    const wasDefault = row.isDefault === true;
    await row.deleteOne({ session });
    if (wasDefault) {
      const nextDefault = await EcommerceCustomerAddress.findOne({
        tenantId: req.auth.tenantId,
        customerId: req.auth.id,
      })
        .sort({ updatedAt: -1 })
        .session(session);
      if (nextDefault) {
        nextDefault.isDefault = true;
        nextDefault.version += 1;
        await nextDefault.save({ session });
      }
    }
    return { id: req.params.addressId, deleted: true };
  });
}

export async function resolveRedemptionDeliveryAddress(req, deliveryAddressId) {
  return loadOwnedCustomerDeliveryAddress({
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
    addressId: deliveryAddressId,
  });
}
