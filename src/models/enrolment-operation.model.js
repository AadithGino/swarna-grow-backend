import mongoose from 'mongoose';
import { baseOptions, tenantField } from './schema-helpers.js';

const schema = new mongoose.Schema({
  _id: { type: String, required: true }, tenantId: tenantField,
  actorId: { type: String, required: true }, scope: { type: String, required: true },
  key: { type: String, required: true }, bodyHash: { type: String, required: true },
  result: { type: mongoose.Schema.Types.Mixed, required: true },
}, baseOptions);
schema.index({ tenantId: 1, actorId: 1, scope: 1, key: 1 }, { unique: true });
export const EnrolmentOperation = mongoose.model('EnrolmentOperation', schema);
