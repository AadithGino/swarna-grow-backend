import { Router } from "express";
import * as controller from "../controllers/ecommerce.controller.js";
import { asyncHandler } from "../lib/async-handler.js";
import { idempotent } from "../middlewares/idempotency.middleware.js";
import { validate } from "../middlewares/validation.middleware.js";
import { guarded } from "../lib/route.js";
import { Permission } from "../constants/permissions.js";
import {
  ecommerceCategoryCreateBody,
  ecommerceCategoryPatchBody,
  ecommerceGoldRateBody,
  ecommerceProductCreateBody,
  ecommerceProductPatchBody,
  ecommerceTaxSettingsBody,
  ecommerceVersionBody,
  ecommerceInventoryPatchBody,
  ecommerceInventoryAdjustBody,
  ecommerceFulfilmentSettingsPutBody,
  ecommerceOrderFulfilmentTransitionBody,
  ecommercePaymentExceptionRefundManualBody,
  ecommercePaymentOperationalAckBody,
  ecommercePaymentReconcileRetryBody,
} from "../validators/ecommerce.validators.js";

export const adminEcommerceRouter = Router();

adminEcommerceRouter.get(
  "/ecommerce/store-status",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.storeStatus)),
);
adminEcommerceRouter.get(
  "/ecommerce/categories",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listCategories)),
);
adminEcommerceRouter.post(
  "/ecommerce/categories",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceCategoryCreateBody }),
    idempotent,
    asyncHandler(controller.createCategory),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/categories/:categoryId",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.getCategory)),
);
adminEcommerceRouter.patch(
  "/ecommerce/categories/:categoryId",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceCategoryPatchBody }),
    asyncHandler(controller.patchCategory),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/categories/:categoryId/archive",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceVersionBody }),
    idempotent,
    asyncHandler(controller.archiveCategory),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/products",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listProducts)),
);
adminEcommerceRouter.post(
  "/ecommerce/products",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceProductCreateBody }),
    idempotent,
    asyncHandler(controller.createProduct),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/products/:productId",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.getProduct)),
);
adminEcommerceRouter.patch(
  "/ecommerce/products/:productId",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceProductPatchBody }),
    asyncHandler(controller.patchProduct),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/products/:productId/publish",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceVersionBody }),
    idempotent,
    asyncHandler(controller.publishProduct),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/products/:productId/archive",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceVersionBody }),
    idempotent,
    asyncHandler(controller.archiveProduct),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/products/:productId/price-preview",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.previewProductPrice)),
);
adminEcommerceRouter.post(
  "/ecommerce/gold-rates",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceGoldRateBody }),
    idempotent,
    asyncHandler(controller.setGoldRate),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/gold-rates/history",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.goldRateHistory)),
);
adminEcommerceRouter.get(
  "/ecommerce/gold-rates/current",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.goldRatesCurrent)),
);
adminEcommerceRouter.get(
  "/ecommerce/tax-settings",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.taxSettings)),
);
adminEcommerceRouter.put(
  "/ecommerce/tax-settings",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceTaxSettingsBody }),
    asyncHandler(controller.putTaxSettings),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/inventory",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listInventory)),
);
adminEcommerceRouter.get(
  "/ecommerce/inventory/:productId",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.getInventoryProduct)),
);
adminEcommerceRouter.patch(
  "/ecommerce/inventory/:productId",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceInventoryPatchBody }),
    asyncHandler(controller.patchInventoryProduct),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/inventory/:productId/adjust",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceInventoryAdjustBody }),
    idempotent,
    asyncHandler(controller.adjustInventoryProduct),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/fulfilment-settings",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.getFulfilmentSettings)),
);
adminEcommerceRouter.put(
  "/ecommerce/fulfilment-settings",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceFulfilmentSettingsPutBody }),
    asyncHandler(controller.putFulfilmentSettings),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/payment-exceptions",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listPaymentExceptions)),
);
adminEcommerceRouter.get(
  "/ecommerce/orders",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listOrders)),
);
adminEcommerceRouter.get(
  "/ecommerce/orders/:orderId",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.getOrder)),
);
adminEcommerceRouter.get(
  "/ecommerce/orders/:orderId/payment-attempts",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listOrderPaymentAttempts)),
);
adminEcommerceRouter.get(
  "/ecommerce/orders/:orderId/payment-attempt-events",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listOrderPaymentAttemptEvents)),
);
adminEcommerceRouter.get(
  "/ecommerce/orders/:orderId/payment-exception-refund",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.getOrderPaymentExceptionRefund)),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/payment-exception-refund/initiate",
  ...guarded(
    Permission.ECOMMERCE_REFUND_OPERATE,
    asyncHandler(controller.initiateOrderPaymentExceptionRefund),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/payment-exception-refund/record-manual",
  ...guarded(
    Permission.ECOMMERCE_REFUND_OPERATE,
    validate({ body: ecommercePaymentExceptionRefundManualBody }),
    asyncHandler(controller.recordOrderPaymentExceptionRefundManual),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/fulfilment-transition",
  ...guarded(
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
    validate({ body: ecommerceOrderFulfilmentTransitionBody }),
    asyncHandler(controller.transitionOrderFulfilment),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/orders/:orderId/events",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listOrderEvents)),
);
adminEcommerceRouter.get(
  "/ecommerce/orders/:orderId/payment-attempts/:paymentAttemptId/provider-status",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.getOrderPaymentAttemptProviderStatus)),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/payment-attempts/:paymentAttemptId/reconcile-retry",
  ...guarded(
    Permission.ECOMMERCE_PAYMENT_OPERATE,
    validate({ body: ecommercePaymentReconcileRetryBody }),
    asyncHandler(controller.retryOrderPaymentAttemptReconcile),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/payment-attempts/:paymentAttemptId/operational-ack",
  ...guarded(
    Permission.ECOMMERCE_PAYMENT_OPERATE,
    validate({ body: ecommercePaymentOperationalAckBody }),
    asyncHandler(controller.acknowledgeOrderPaymentAttemptOperational),
  ),
);
