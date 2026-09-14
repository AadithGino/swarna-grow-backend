import crypto from "node:crypto";
import { env } from "../config/env.js";

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const hmacSha256 = (secret, value) => crypto.createHmac("sha256", secret).update(value).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const timingSafeEqual = (left, right) => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const encryptionKey = crypto.createHash("sha256").update(env.INTEGRATION_ENCRYPTION_KEY).digest();
export const seal = (value) => { if (!value) return value; const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv); const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]); return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join("."); };
export const unseal = (value) => { if (!value) return value; const [iv, tag, encrypted] = value.split("."); const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(iv, "base64url")); decipher.setAuthTag(Buffer.from(tag, "base64url")); return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8"); };
