import { AppError } from "../lib/app-error.js";
import { mapFulfilmentSettings } from "../lib/ecommerce-fulfilment.js";
import { Branch, EcommerceFulfilmentSettings } from "../models/index.js";
import { previewBooking } from "./ecommerce-booking.service.js";

/**
 * Every pickup branch where this piece can be booked, each with its own preview, so a storefront
 * can offer exactly the choices that will work instead of probing one branch and guessing.
 *
 * A branch is left out when booking is refused there (no policy, branch not eligible, booking
 * switched off for it, product not bookable). Anything that is not such a refusal still fails the
 * request: an outage must not look like "nothing is bookable".
 */
export async function listBookableBranches({ tenantId, productId, at = new Date() }) {
  const settings = await EcommerceFulfilmentSettings.findOne({ tenantId }).lean();
  const mapped = mapFulfilmentSettings(settings ?? {});
  if (!mapped.pickupEnabled || !mapped.pickupBranchIds.length) return { branches: [] };

  const branches = await Branch.find({ tenantId, _id: { $in: mapped.pickupBranchIds }, active: { $ne: false } })
    .select("_id name code")
    .sort({ name: 1 })
    .lean();

  const out = [];
  for (const branch of branches) {
    try {
      const preview = await previewBooking({ tenantId, productId, pickupBranchId: branch._id, at });
      out.push({ id: branch._id, name: branch.name, code: branch.code ?? null, preview });
    } catch (err) {
      if (err instanceof AppError && err.statusCode < 500) continue;
      throw err;
    }
  }
  return { branches: out };
}
