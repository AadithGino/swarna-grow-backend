import { z } from "zod";
import { LandingDemoRequestStatus } from "../constants/enums.js";

const MAX_LOGO_DATA_URL = 50_000;

export const landingDemoRequestBody = z
  .object({
    submittedAt: z.string().max(40).optional(),
    source: z.string().max(120).optional(),
    name: z.string().max(200).optional(),
    showroom: z.string().min(1).max(200),
    brandName: z.string().min(1).max(200),
    location: z.string().max(200).optional(),
    logoFileName: z.string().max(260).optional(),
    logoDataUrl: z.string().max(MAX_LOGO_DATA_URL).optional(),
    phone: z.string().min(8).max(20),
    customers: z.string().max(80).optional(),
    planTag: z.string().max(80).optional(),
    planPrice: z.string().max(80).optional(),
    setupFee: z.string().max(40).optional(),
    dataFormat: z.string().max(40).optional(),
    whatsappOptIn: z.boolean().optional(),
    notes: z.string().max(2000).optional(),
    pageUrl: z.string().max(500).optional(),
  })
  .strict();

export const landingDemoRequestIdParam = z.object({
  requestId: z.string().min(4).max(80),
});

export const landingDemoListQuery = z.object({
  status: z.enum(Object.values(LandingDemoRequestStatus)).optional(),
  demoSent: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const landingDemoPatchBody = z
  .object({
    status: z.enum(Object.values(LandingDemoRequestStatus)).optional(),
    notes: z.string().max(2000).optional(),
    demoSent: z.boolean(),
  })
  .strict();