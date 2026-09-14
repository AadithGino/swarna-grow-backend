import path from "node:path";
import { Upload } from "../models/index.js";
import { createId } from "../lib/ids.js";
import { errors } from "../lib/app-error.js";
import { storageProvider } from "../integrations/storage.provider.js";

const RULES = Object.freeze({ TENANT_LOGO: { max: 2_000_000, types: ["image/png", "image/jpeg", "image/webp"] }, KYC_DOCUMENT: { max: 5_000_000, types: ["image/jpeg", "image/png", "application/pdf"] }, GRIEVANCE_ATTACHMENT: { max: 5_000_000, types: ["image/jpeg", "image/png", "application/pdf"] } });
export async function presignUpload(req) { const rule = RULES[req.body.purpose]; if (!rule.types.includes(req.body.contentType) || req.body.sizeBytes > rule.max) throw errors.validation([{ field: "file", message: "The file type or size is not allowed for this purpose." }]); const id = createId("upload"); const safeName = path.basename(req.body.fileName).replace(/[^a-zA-Z0-9._-]/g, "_"); const objectKey = `${req.auth.tenantId}/${req.body.purpose.toLowerCase()}/${id}/${safeName}`; const expiresAt = new Date(Date.now() + 15 * 60_000); const upload = await Upload.create({ _id: id, tenantId: req.auth.tenantId, ownerId: req.auth.id, ...req.body, objectKey, expiresAt }); const uploadUrl = await storageProvider.presignUpload({ objectKey, contentType: upload.contentType }); return { uploadId: id, uploadUrl, method: "PUT", headers: { "Content-Type": upload.contentType }, expiresAt };
}
