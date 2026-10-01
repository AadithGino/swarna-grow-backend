import mongoose from "mongoose";

export const stringId = (prefix) => ({ type: String, required: true, default: () => `${prefix}_${new mongoose.Types.ObjectId().toString()}` });
export const tenantField = { type: String, required: true, index: true };
export const branchField = { type: String, default: null, index: true };
export const integerField = (options = {}) => ({ type: Number, default: 0, validate: { validator: (value) => value == null || Number.isSafeInteger(value), message: "{PATH} must be a safe integer" }, ...options });
/** Integer paise fields that are omitted when unset (legacy-safe reads use ?? fallbacks). */
export const optionalIntegerField = (options = {}) => ({
  type: Number,
  validate: {
    validator: (value) => value == null || Number.isSafeInteger(value),
    message: "{PATH} must be a safe integer",
  },
  ...options,
});
export const versionField = integerField({ default: 1, min: 1 });
export const baseOptions = { timestamps: true, versionKey: false, strict: "throw", minimize: false };
export const enumField = (enumeration, options = {}) => ({ type: String, enum: Object.values(enumeration), ...options });

export function immutablePlugin(schema) {
  const reject = (next) => next(new Error("Immutable records cannot be modified or deleted"));
  for (const hook of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete", "bulkWrite"]) schema.pre(hook, reject);
  schema.pre("save", function immutableSave(next) { if (!this.isNew) return next(new Error("Immutable records cannot be modified or deleted")); return next(); });
  schema.pre("deleteOne", { document: true, query: false }, reject);
}
