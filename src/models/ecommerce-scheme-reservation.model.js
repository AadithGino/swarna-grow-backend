import mongoose from "mongoose";
import { baseOptions, integerField, stringId, tenantField } from "./schema-helpers.js";

const allocationSchema = new mongoose.Schema({
  productId: { type: String, required: true },
  quantity: integerField({ min: 1 }),
  schemeUnits: integerField({ min: 0 }),
  benefitUnits: { type: Number, min: 0 },
  schemePaise: integerField({ min: 0 }),
  cashPaise: integerField({ min: 0 }),
  waiverPaise: integerField({ min: 0 }),
  returnedQuantity: integerField({ min: 0, default: 0 }),
}, { _id: false });

const reservationSchema = new mongoose.Schema({
  _id: stringId("esr"),
  tenantId: tenantField,
  schemeId: { type: String, required: true },
  customerId: { type: String, required: true },
  orderId: { type: String, required: true },
  basis: { type: String, required: true, enum: ["CASH_VALUE", "GOLD_WEIGHT"] },
  status: { type: String, required: true, enum: ["HELD", "CONSUMED", "RELEASED"] },
  units: integerField({ min: 1 }),
  balanceAtReservation: Number,
  schemeVersionAtReservation: Number,
  waiverPaise: integerField({ min: 0 }),
  restoredUnits: integerField({ min: 0, default: 0 }),
  restoredWaiverPaise: integerField({ min: 0, default: 0 }),
  lines: { type: [allocationSchema], required: true },
  returns: [{
    _id: false,
    reference: { type: String, required: true },
    items: mongoose.Schema.Types.Mixed,
    restoredUnits: Number,
    restoredBenefitUnits: Number,
    refundedCashPaise: Number,
    restoredWaiverPaise: Number,
  }],
}, baseOptions);

reservationSchema.index({ tenantId: 1, orderId: 1 }, { unique: true });
reservationSchema.index({ tenantId: 1, schemeId: 1, status: 1 });

export const EcommerceSchemeReservation = mongoose.model("EcommerceSchemeReservation", reservationSchema);
