import mongoose from "mongoose";
import { baseOptions, integerField } from "./schema-helpers.js";

const counterSchema = new mongoose.Schema({ _id: { type: String, required: true }, value: integerField({ min: 0 }) }, baseOptions);
export const Counter = mongoose.model("Counter", counterSchema);

