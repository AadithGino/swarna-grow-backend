import { z } from "zod";

const id = z.string().trim().min(4).max(80);

export const demoTemplateIdParam = z.object({ templateId: id }).strict();
export const demoInstanceIdParam = z.object({ instanceId: id }).strict();
export const demoPublicIdParam = z.object({ publicId: id }).strict();

export const demoRegisterTemplateBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    approvedSourceTenantId: id,
  })
  .strict();

export const demoPublishVersionBody = z.object({}).strict();

const demoBrandingInput = z
  .object({
    logoUploadId: z.string().trim().max(120).nullable().optional(),
    primaryColor: z
      .string()
      .trim()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
    accentColor: z
      .string()
      .trim()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
    displayName: z.string().trim().max(120).optional(),
    splashBackgroundColor: z
      .string()
      .trim()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
    splashTagline: z.string().trim().max(160).optional(),
    splashEnabled: z.boolean().optional(),
  })
  .strict();

export const demoCreateInstanceBody = z
  .object({
    templateId: id,
    prospectName: z.string().trim().min(2).max(120),
    prospectContactMobile: z
      .string()
      .trim()
      .regex(/^\+?[1-9]\d{9,14}$/)
      .optional(),
    branding: demoBrandingInput.optional(),
    expiryDays: z.number().int().min(1).max(90).optional(),
    rememberLinkSecret: z.boolean().optional(),
  })
  .strict();

export const demoUpdateInstanceBody = z
  .object({
    expectedVersion: z.number().int().min(0),
    prospectName: z.string().trim().min(2).max(120).optional(),
    prospectContactMobile: z
      .string()
      .trim()
      .regex(/^\+?[1-9]\d{9,14}$/)
      .nullable()
      .optional(),
    branding: demoBrandingInput.optional(),
  })
  .strict();

export const demoListInstancesQuery = z
  .object({
    status: z.string().trim().max(32).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const demoExchangeSessionBody = z
  .object({
    secret: z.string().trim().min(16).max(256),
    device: z
      .object({
        deviceId: z.string().trim().max(120).optional(),
        platform: z.string().trim().max(32).optional(),
        appVersion: z.string().trim().max(32).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
