import {
  AuditEntityType,
  EcommerceBannerDestination,
  EcommerceBannerPlacement,
  EcommerceBannerStatus,
  EcommerceProductStatus,
  UploadPurpose,
} from "../constants/enums.js";
import { EcommerceBanner, EcommerceCategory, EcommerceProduct } from "../models/index.js";
import {
  assertEcommerceCatalogWrite,
  assertEcommerceOperational,
  ECOMMERCE_PLAN_FEATURE,
  isEcommerceOperational,
} from "../lib/ecommerce-access.js";
import { isPlanFeatureEnabled } from "../lib/feature-entitlements.js";
import { customerHasEcommerceOrderHistory } from "../lib/ecommerce-tenant-history.js";
import { createId } from "../lib/ids.js";
import { paginate } from "../lib/pagination.js";
import { errors } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import {
  isBannerInSchedule,
  isBannerTargetAvailable,
  destinationRequiresOperationalStore,
  placementIncludes,
} from "../lib/ecommerce-banner-utils.js";
import { writeAudit } from "./audit.service.js";
import {
  computeNextVisibilityChangeAt,
  loadPublishedBannersForSurface,
  surfaceEligibleForRefresh,
} from "../lib/ecommerce-banner-customer-meta.js";
import {
  assertRetainedTenantUpload,
  uploadViewPath,
  validateUploadReferences,
} from "./upload.service.js";

export { isBannerInSchedule, placementIncludes, isBannerTargetAvailable };

function enforceVersion(doc, expectedVersion) {
  if (expectedVersion == null) return;
  if (Number(doc.version) !== Number(expectedVersion)) {
    throw errors.conflict("VERSION_CONFLICT", "Record was updated elsewhere. Refresh and retry.");
  }
}

function parseOptionalDate(value) {
  if (value == null || value === "") return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw errors.validation([{ field: "date", message: "Invalid date/time." }]);
  }
  return d;
}

const TARGET_DESTINATIONS = new Set([
  EcommerceBannerDestination.CATEGORY,
  EcommerceBannerDestination.PRODUCT,
]);

const NO_TARGET_DESTINATIONS = new Set([
  EcommerceBannerDestination.NONE,
  EcommerceBannerDestination.HOME,
  EcommerceBannerDestination.SHOP,
  EcommerceBannerDestination.SCHEMES,
  EcommerceBannerDestination.ORDERS,
]);

async function assertCategoryTarget(tenantId, categoryId, session) {
  const row = await EcommerceCategory.findOne({
    _id: categoryId,
    tenantId,
    active: true,
  })
    .session(session ?? null)
    .lean();
  if (!row) {
    throw errors.validation([
      { field: "targetCategoryId", message: "Category is missing or inactive.", code: "TARGET_UNAVAILABLE" },
    ]);
  }
  return row;
}

async function assertProductTarget(tenantId, productId, session) {
  const row = await EcommerceProduct.findOne({
    _id: productId,
    tenantId,
    status: EcommerceProductStatus.PUBLISHED,
  })
    .session(session ?? null)
    .lean();
  if (!row) {
    throw errors.validation([
      { field: "targetProductId", message: "Product is missing or not published.", code: "TARGET_UNAVAILABLE" },
    ]);
  }
  if (row.categoryId) {
    await assertCategoryTarget(tenantId, row.categoryId, session);
  }
  return row;
}

function validateDateWindow(body) {
  const startsAt = body.startsAt != null ? parseOptionalDate(body.startsAt) : undefined;
  const endsAt = body.endsAt != null ? parseOptionalDate(body.endsAt) : undefined;
  if (startsAt && endsAt && startsAt > endsAt) {
    throw errors.validation([
      { field: "endsAt", message: "End date must be on or after the start date." },
    ]);
  }
  return { startsAt, endsAt };
}

function validateDestinationFields(body) {
  const dest = body.destinationType ?? EcommerceBannerDestination.NONE;
  const categoryId = body.targetCategoryId ?? null;
  const productId = body.targetProductId ?? null;

  if (TARGET_DESTINATIONS.has(dest)) {
    if (dest === EcommerceBannerDestination.CATEGORY && !categoryId) {
      throw errors.validation([
        { field: "targetCategoryId", message: "Category target is required for this destination." },
      ]);
    }
    if (dest === EcommerceBannerDestination.PRODUCT && !productId) {
      throw errors.validation([
        { field: "targetProductId", message: "Product target is required for this destination." },
      ]);
    }
  }
  if (NO_TARGET_DESTINATIONS.has(dest) && (categoryId || productId)) {
    throw errors.validation([
      { field: "destinationType", message: "Remove category/product targets for this destination type." },
    ]);
  }
}

async function validateDestinationTargets(tenantId, body, session) {
  validateDestinationFields(body);
  const dest = body.destinationType ?? EcommerceBannerDestination.NONE;
  if (dest === EcommerceBannerDestination.CATEGORY) {
    await assertCategoryTarget(tenantId, body.targetCategoryId, session);
  }
  if (dest === EcommerceBannerDestination.PRODUCT) {
    await assertProductTarget(tenantId, body.targetProductId, session);
  }
}

async function validateBannerPublishable(row, tenantId, session) {
  if (!row.imageUploadId) {
    throw errors.validation([
      { field: "imageUploadId", message: "An image is required before publishing." },
    ]);
  }
  const now = new Date();
  if (row.endsAt && now > new Date(row.endsAt)) {
    throw errors.validation([
      { field: "endsAt", message: "End date is in the past; adjust the schedule before publishing." },
    ]);
  }
  await validateDestinationTargets(
    tenantId,
    {
      destinationType: row.destinationType,
      targetCategoryId: row.targetCategoryId,
      targetProductId: row.targetProductId,
    },
    session,
  );
}

function mapBannerAdmin(row) {
  return {
    id: row._id,
    title: row.title,
    subtitle: row.subtitle ?? "",
    imageUploadId: row.imageUploadId ?? null,
    imageUrl: row.imageUploadId ? uploadViewPath(row.imageUploadId) : null,
    placement: row.placement,
    displayOrder: row.displayOrder ?? 0,
    status: row.status,
    destinationType: row.destinationType,
    targetCategoryId: row.targetCategoryId ?? null,
    targetProductId: row.targetProductId ?? null,
    startsAt: row.startsAt ? new Date(row.startsAt).toISOString() : null,
    endsAt: row.endsAt ? new Date(row.endsAt).toISOString() : null,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function resolveCustomerDestination(row, tenantId, customerId, tenant) {
  const type = row.destinationType ?? EcommerceBannerDestination.NONE;
  if (destinationRequiresOperationalStore(type) && !isEcommerceOperational(tenant)) {
    return null;
  }
  if (type === EcommerceBannerDestination.NONE) {
    return { type: "NONE" };
  }
  if (type === EcommerceBannerDestination.HOME) {
    return { type: "HOME" };
  }
  if (type === EcommerceBannerDestination.SHOP) {
    return { type: "SHOP" };
  }
  if (type === EcommerceBannerDestination.SCHEMES) {
    return { type: "SCHEMES" };
  }
  if (type === EcommerceBannerDestination.ORDERS) {
    const hasHistory = customerId
      ? await customerHasEcommerceOrderHistory(tenantId, customerId)
      : false;
    if (!hasHistory) return null;
    return { type: "ORDERS" };
  }
  if (type === EcommerceBannerDestination.CATEGORY) {
    const category = await EcommerceCategory.findOne({
      _id: row.targetCategoryId,
      tenantId,
      active: true,
    }).lean();
    if (!category) return null;
    return { type: "CATEGORY", categoryId: category._id };
  }
  if (type === EcommerceBannerDestination.PRODUCT) {
    const product = await EcommerceProduct.findOne({
      _id: row.targetProductId,
      tenantId,
      status: EcommerceProductStatus.PUBLISHED,
    }).lean();
    if (!product) return null;
    if (product.categoryId) {
      const category = await EcommerceCategory.findOne({
        _id: product.categoryId,
        tenantId,
        active: true,
      }).lean();
      if (!category) return null;
    }
    return { type: "PRODUCT", productId: product._id, slug: product.slug };
  }
  return null;
}

async function mapBannerCustomer(row, tenantId, customerId, tenant) {
  const destination = await resolveCustomerDestination(row, tenantId, customerId, tenant);
  if (destination == null) return null;
  return {
    id: row._id,
    title: row.title,
    subtitle: row.subtitle ?? "",
    imageUploadId: row.imageUploadId,
    imageUrl: row.imageUploadId ? uploadViewPath(row.imageUploadId) : null,
    displayOrder: row.displayOrder ?? 0,
    startsAt: row.startsAt ? new Date(row.startsAt).toISOString() : null,
    endsAt: row.endsAt ? new Date(row.endsAt).toISOString() : null,
    destination,
  };
}

function applyBannerPatch(row, body) {
  const patch = { ...body };
  delete patch.expectedVersion;
  delete patch.imageUploadId;
  if (patch.title != null) patch.title = String(patch.title).trim();
  if (patch.subtitle != null) patch.subtitle = String(patch.subtitle).trim();

  let nextStarts = row.startsAt;
  let nextEnds = row.endsAt;
  if (Object.prototype.hasOwnProperty.call(body, "startsAt")) {
    nextStarts = body.startsAt == null ? undefined : parseOptionalDate(body.startsAt);
  }
  if (Object.prototype.hasOwnProperty.call(body, "endsAt")) {
    nextEnds = body.endsAt == null ? undefined : parseOptionalDate(body.endsAt);
  }
  validateDateWindow({ startsAt: nextStarts, endsAt: nextEnds });
  if (Object.prototype.hasOwnProperty.call(body, "startsAt")) row.startsAt = nextStarts;
  if (Object.prototype.hasOwnProperty.call(body, "endsAt")) row.endsAt = nextEnds;

  delete patch.startsAt;
  delete patch.endsAt;
  Object.assign(row, patch);
}

export async function listBanners(req) {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.placement) filter.placement = req.query.placement;
  const result = await paginate(EcommerceBanner, {
    scope: { tenantId: req.auth.tenantId },
    filters: filter,
    sort: "displayOrder:asc",
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  return {
    items: result.data.map(mapBannerAdmin),
    meta: result.meta,
  };
}

export async function getBanner(req) {
  const row = await EcommerceBanner.findOne({
    _id: req.params.bannerId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!row) throw errors.notFound("Banner");
  return mapBannerAdmin(row);
}

export async function createBanner(req) {
  assertEcommerceCatalogWrite(req.tenant);
  validateDestinationFields(req.body);
  const { startsAt, endsAt } = validateDateWindow(req.body);
  return withTransaction(async (session) => {
    await validateDestinationTargets(req.auth.tenantId, req.body, session);
    const row = (
      await EcommerceBanner.create(
        [
          {
            _id: createId("ebnr"),
            tenantId: req.auth.tenantId,
            title: String(req.body.title).trim(),
            subtitle: req.body.subtitle ?? "",
            placement: req.body.placement,
            displayOrder: req.body.displayOrder ?? 0,
            status: EcommerceBannerStatus.DRAFT,
            destinationType: req.body.destinationType ?? EcommerceBannerDestination.NONE,
            targetCategoryId: req.body.targetCategoryId ?? undefined,
            targetProductId: req.body.targetProductId ?? undefined,
            startsAt,
            endsAt,
          },
        ],
        { session },
      )
    )[0];
    if (req.body.imageUploadId) {
      await validateUploadReferences({
        req,
        uploadIds: [req.body.imageUploadId],
        purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
        session,
        entityType: "ECOMMERCE_BANNER",
        entityId: row._id,
      });
      row.imageUploadId = req.body.imageUploadId;
      await row.save({ session });
    }
    await writeAudit({
      req,
      action: "ECOMMERCE_BANNER_CREATED",
      entityType: AuditEntityType.ECOMMERCE_BANNER,
      entityId: row._id,
      after: row.toObject(),
      session,
    });
    return mapBannerAdmin(row.toObject());
  });
}

export async function patchBanner(req) {
  assertEcommerceCatalogWrite(req.tenant);
  return withTransaction(async (session) => {
    const row = await EcommerceBanner.findOne({
      _id: req.params.bannerId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!row) throw errors.notFound("Banner");
    if (row.status === EcommerceBannerStatus.ARCHIVED) {
      throw errors.validation([{ field: "status", message: "Archived banners cannot be edited." }]);
    }
    enforceVersion(row, req.body.expectedVersion);
    const merged = {
      destinationType: req.body.destinationType ?? row.destinationType,
      targetCategoryId:
        req.body.targetCategoryId !== undefined ? req.body.targetCategoryId : row.targetCategoryId,
      targetProductId:
        req.body.targetProductId !== undefined ? req.body.targetProductId : row.targetProductId,
      startsAt: req.body.startsAt !== undefined ? req.body.startsAt : row.startsAt,
      endsAt: req.body.endsAt !== undefined ? req.body.endsAt : row.endsAt,
    };
    validateDestinationFields(merged);
    await validateDestinationTargets(req.auth.tenantId, merged, session);
    if (Object.prototype.hasOwnProperty.call(req.body, "imageUploadId")) {
      const nextImageId = req.body.imageUploadId;
      if (nextImageId == null || nextImageId === "") {
        if (row.status === EcommerceBannerStatus.PUBLISHED) {
          throw errors.validation([
            {
              field: "imageUploadId",
              message: "Published banners must keep an image. Unpublish first to remove it.",
            },
          ]);
        }
        row.imageUploadId = undefined;
      } else if (nextImageId === row.imageUploadId) {
        await assertRetainedTenantUpload({
          req,
          uploadId: nextImageId,
          purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
          entityType: "ECOMMERCE_BANNER",
          entityId: row._id,
          session,
        });
      } else {
        await validateUploadReferences({
          req,
          uploadIds: [nextImageId],
          purpose: UploadPurpose.ECOMMERCE_BANNER_IMAGE,
          session,
          entityType: "ECOMMERCE_BANNER",
          entityId: row._id,
        });
        row.imageUploadId = nextImageId;
      }
    }
    applyBannerPatch(row, req.body);
    row.version += 1;
    await row.save({ session });
    await writeAudit({
      req,
      action: "ECOMMERCE_BANNER_UPDATED",
      entityType: AuditEntityType.ECOMMERCE_BANNER,
      entityId: row._id,
      after: row.toObject(),
      session,
    });
    return mapBannerAdmin(row.toObject());
  });
}

async function transitionBannerStatus(req, status) {
  assertEcommerceCatalogWrite(req.tenant);
  return withTransaction(async (session) => {
    const row = await EcommerceBanner.findOne({
      _id: req.params.bannerId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!row) throw errors.notFound("Banner");
    if (row.status === EcommerceBannerStatus.ARCHIVED) {
      throw errors.validation([
        { field: "status", message: "Archived banners cannot be published, unpublished, or changed." },
      ]);
    }
    enforceVersion(row, req.body.expectedVersion);
    if (status === EcommerceBannerStatus.PUBLISHED) {
      await validateBannerPublishable(row, req.auth.tenantId, session);
    }
    row.status = status;
    row.version += 1;
    await row.save({ session });
    await writeAudit({
      req,
      action: `ECOMMERCE_BANNER_${status}`,
      entityType: AuditEntityType.ECOMMERCE_BANNER,
      entityId: row._id,
      after: row.toObject(),
      session,
    });
    return mapBannerAdmin(row.toObject());
  });
}

export async function publishBanner(req) {
  return transitionBannerStatus(req, EcommerceBannerStatus.PUBLISHED);
}

export async function unpublishBanner(req) {
  return transitionBannerStatus(req, EcommerceBannerStatus.DRAFT);
}

export async function archiveBanner(req) {
  return transitionBannerStatus(req, EcommerceBannerStatus.ARCHIVED);
}

function customerBannerListMeta(rows, now = new Date()) {
  return {
    nextVisibilityChangeAt: computeNextVisibilityChangeAt(rows, now),
    serverTime: now.toISOString(),
  };
}

async function listVisibleBannersForSurface(req, surface) {
  const now = new Date();
  if (!surfaceEligibleForRefresh(req.tenant, surface)) {
    return { items: [], meta: customerBannerListMeta([], now) };
  }
  const rows = await loadPublishedBannersForSurface(req.auth.tenantId, surface);
  const meta = customerBannerListMeta(rows, now);

  const items = [];
  for (const row of rows) {
    if (!isBannerInSchedule(row, now)) continue;
    if (!row.imageUploadId) continue;
    const mapped = await mapBannerCustomer(row, req.auth.tenantId, req.auth.id, req.tenant);
    if (mapped) items.push(mapped);
  }
  return { items, meta };
}

export async function shopHomeBanners(req) {
  if (!isPlanFeatureEnabled(req.tenant, ECOMMERCE_PLAN_FEATURE)) {
    const now = new Date();
    return { items: [], meta: customerBannerListMeta([], now) };
  }
  return listVisibleBannersForSurface(req, EcommerceBannerPlacement.HOME);
}

export async function shopStorefrontBanners(req) {
  try {
    assertEcommerceOperational(req.tenant);
  } catch {
    const now = new Date();
    return { items: [], meta: customerBannerListMeta([], now) };
  }
  return listVisibleBannersForSurface(req, EcommerceBannerPlacement.SHOP);
}
