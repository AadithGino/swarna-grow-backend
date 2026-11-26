import { LandingDemoRequestStatus } from "../constants/enums.js";
import { createId } from "../lib/ids.js";
import { AppError } from "../lib/app-error.js";
import { LandingDemoRequest } from "../models/index.js";
import {
  autoProvisionLandingDemoRequest,
  landingDemoInstanceStatus,
  scheduleLandingDemoAutoProvision,
} from "./landing-demo-auto-provision.service.js";
import { copyLink } from "./demo-instance.service.js";
import { env } from "../config/env.js";
async function mapRow(row) {
  const demoInstanceStatus = await landingDemoInstanceStatus(row.demoInstanceId);
  return {
    id: row._id,
    status: row.status,
    source: row.source,
    showroom: row.showroom,
    brandName: row.brandName,
    location: row.location ?? "",
    phone: row.phone,
    customers: row.customers ?? "",
    planTag: row.planTag ?? "",
    planPrice: row.planPrice ?? "",
    setupFee: row.setupFee ?? "",
    logoFileName: row.logoFileName ?? "",
    logoDataUrl: row.logoDataUrl ?? "",
    pageUrl: row.pageUrl ?? "",
    whatsappOptIn: row.whatsappOptIn !== false,
    notes: row.notes ?? "",
    demoSent: Boolean(row.demoSent),
    demoSentAt: row.demoSentAt?.toISOString?.() ?? null,
    provisionStatus: row.provisionStatus,
    provisionError: row.provisionError ?? null,
    demoInstanceId: row.demoInstanceId ?? null,
    demoPublicId: row.demoPublicId ?? null,
    demoTemplateId: row.demoTemplateId ?? null,
    demoInstanceStatus,
    autoPrimaryColor: row.autoPrimaryColor ?? null,
    autoAccentColor: row.autoAccentColor ?? null,
    autoSplashBackgroundColor: row.autoSplashBackgroundColor ?? null,
    logoUploadId: row.logoUploadId ?? null,
    submittedAt: row.createdAt?.toISOString?.() ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createLandingDemoRequest(body) {
  const doc = await LandingDemoRequest.create({
    _id: createId("landingDemoRequest"),
    status: LandingDemoRequestStatus.NEW,
    source: body.source?.trim() || "landing-page-free-demo",
    showroom: body.showroom.trim(),
    brandName: body.brandName.trim(),
    location: body.location?.trim() ?? "",
    phone: body.phone.trim(),
    customers: body.customers?.trim() ?? "",
    planTag: body.planTag?.trim() ?? "",
    planPrice: body.planPrice?.trim() ?? "",
    setupFee: body.setupFee?.trim() ?? "",
    logoFileName: body.logoFileName?.trim() ?? "",
    logoDataUrl: body.logoDataUrl ?? "",
    pageUrl: body.pageUrl?.trim() ?? "",
    whatsappOptIn: body.whatsappOptIn !== false,
    notes: body.notes?.trim() ?? "",
  });
  scheduleLandingDemoAutoProvision(doc._id);
  return mapRow(doc.toObject());
}

export async function listLandingDemoRequests({ status, limit, offset, demoSent }) {
  const filter = {};
  if (status) filter.status = status;
  if (demoSent === "true") filter.demoSent = true;
  if (demoSent === "false") filter.demoSent = false;
  const [rows, total] = await Promise.all([
    LandingDemoRequest.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
    LandingDemoRequest.countDocuments(filter),
  ]);
  return {
    rows: await Promise.all(rows.map((row) => mapRow(row))),
    total,
    limit,
    offset,
  };
}

export async function getLandingDemoRequest(requestId) {
  const row = await LandingDemoRequest.findById(requestId).lean();
  if (!row) {
    throw new AppError("NOT_FOUND", "Demo request not found.", 404);
  }
  return mapRow(row);
}

export async function updateLandingDemoRequest(requestId, body) {
  if (body.status === LandingDemoRequestStatus.ARCHIVED && body.demoSent !== true) {
    throw new AppError(
      "DEMO_NOT_MARKED_SENT",
      "Mark the demo as sent before archiving this request.",
      422,
    );
  }

  const patch = {
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
    demoSent: body.demoSent === true,
    ...(body.demoSent === true ? { demoSentAt: new Date() } : { demoSentAt: null }),
  };

  const row = await LandingDemoRequest.findOneAndUpdate(
    { _id: requestId },
    { $set: patch, $inc: { version: 1 } },
    { new: true },
  ).lean();
  if (!row) {
    throw new AppError("NOT_FOUND", "Demo request not found.", 404);
  }
  return mapRow(row);
}

export async function shareLinkForLandingDemoRequest(requestId) {
  const row = await LandingDemoRequest.findById(requestId).lean();
  if (!row?.demoInstanceId) {
    throw new AppError("DEMO_NOT_READY", "This request does not have a provisioned demo yet.", 422);
  }
  const link = await copyLink(row.demoInstanceId);
  const base = String(env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  const path = `/demo/${link.publicId}?s=${encodeURIComponent(link.linkSecret)}`;
  return {
    publicId: link.publicId,
    linkSecret: link.linkSecret,
    sharePath: path,
    shareUrl: base ? `${base}${path}` : path,
  };
}

export async function retryLandingDemoProvision(requestId) {
  const row = await LandingDemoRequest.findById(requestId).lean();
  if (!row) throw new AppError("NOT_FOUND", "Demo request not found.", 404);
  if (row.demoInstanceId) {
    throw new AppError("DEMO_ALREADY_EXISTS", "A demo instance is already linked to this request.", 409);
  }
  await autoProvisionLandingDemoRequest(requestId);
  return getLandingDemoRequest(requestId);
}