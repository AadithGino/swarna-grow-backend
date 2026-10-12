import { Router } from "express";
import * as controller from "../controllers/customer.controller.js";
import * as upload from "../controllers/upload.controller.js";
import { asyncHandler } from "../lib/async-handler.js";
import { idempotent } from "../middlewares/idempotency.middleware.js";
import { validate } from "../middlewares/validation.middleware.js";
import {
  customerBody,
  customerBlockBody,
  customerNoteBody,
  customerPatchBody,
  customerSetPasswordBody,
  kycSubmitBody,
  nomineeBody,
  whatsappOptBody,
} from "../validators/common.validators.js";
import { kycVerifyBody } from "../validators/admin-mutation.validators.js";
import { Permission } from "../constants/permissions.js";
import { sendList } from "../lib/response.js";
import { Customer } from "../models/index.js";
import { guarded } from "../lib/route.js";
import { errors } from "../lib/app-error.js";
import * as audit from "../services/audit.service.js";
import * as ecommerceController from "../controllers/ecommerce.controller.js";
import { cursorQuery } from "../validators/common.validators.js";

export const adminCustomerRouter = Router();
adminCustomerRouter.get(
  "/analytics",
  ...guarded(Permission.REPORT_READ, asyncHandler(controller.analytics)),
);
adminCustomerRouter.get(
  "/check-mobile",
  ...guarded(Permission.CUSTOMER_READ, asyncHandler(controller.checkMobile)),
);
adminCustomerRouter.get(
  "/",
  ...guarded(Permission.CUSTOMER_READ, asyncHandler(controller.list)),
);
adminCustomerRouter.post(
  "/",
  ...guarded(
    Permission.CUSTOMER_WRITE,
    validate({ body: customerBody }),
    idempotent,
    asyncHandler(controller.create),
  ),
);
adminCustomerRouter.get(
  "/:customerId",
  ...guarded(Permission.CUSTOMER_READ, asyncHandler(controller.detail)),
);
adminCustomerRouter.get(
  "/:customerId/schemes",
  ...guarded(
    Permission.SCHEME_READ,
    asyncHandler(controller.relations("schemes")),
  ),
);
adminCustomerRouter.get(
  "/:customerId/payments",
  ...guarded(
    Permission.PAYMENT_READ,
    asyncHandler(controller.relations("payments")),
  ),
);
adminCustomerRouter.get(
  "/:customerId/messages",
  ...guarded(
    Permission.MESSAGE_READ,
    asyncHandler(controller.relations("messages")),
  ),
);
adminCustomerRouter.get(
  "/:customerId/ecommerce/orders/meta",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(ecommerceController.getCustomerEcommerceOrdersMeta)),
);
adminCustomerRouter.get(
  "/:customerId/ecommerce/orders",
  ...guarded(
    Permission.ECOMMERCE_READ,
    validate({ query: cursorQuery }),
    asyncHandler(ecommerceController.listCustomerEcommerceOrders),
  ),
);
adminCustomerRouter.patch(
  "/:customerId",
  ...guarded(
    Permission.CUSTOMER_WRITE,
    validate({ body: customerPatchBody }),
    idempotent,
    asyncHandler(controller.update),
  ),
);
adminCustomerRouter.post(
  "/:customerId/set-password",
  ...guarded(
    Permission.CUSTOMER_PASSWORD_WRITE,
    validate({ body: customerSetPasswordBody }),
    idempotent,
    asyncHandler(controller.setPassword),
  ),
);
adminCustomerRouter.patch(
  "/:customerId/whatsapp-opt",
  ...guarded(
    Permission.CUSTOMER_WRITE,
    validate({ body: whatsappOptBody }),
    idempotent,
    asyncHandler(controller.whatsappOpt),
  ),
);
adminCustomerRouter.post(
  "/:customerId/notes",
  ...guarded(
    Permission.CUSTOMER_WRITE,
    validate({ body: customerNoteBody }),
    idempotent,
    asyncHandler(controller.note),
  ),
);
adminCustomerRouter.get(
  "/:customerId/audit-events",
  ...guarded(
    Permission.AUDIT_READ,
    asyncHandler(async (req, res) => {
      const customer = await Customer.findOne({
        _id: req.params.customerId,
        ...req.scope,
      }).lean();
      if (!customer) throw errors.notFound("Customer");
      return sendList(
        res,
        await audit.listCustomerAudit(req, customer._id),
      );
    }),
  ),
);
adminCustomerRouter.get(
  "/:customerId/uploads/:uploadId",
  ...guarded(Permission.CUSTOMER_READ, asyncHandler(upload.download)),
);
adminCustomerRouter.put(
  "/:customerId/kyc",
  ...guarded(
    Permission.CUSTOMER_KYC,
    validate({ body: kycSubmitBody }),
    idempotent,
    asyncHandler(controller.kyc(false)),
  ),
);
adminCustomerRouter.post(
  "/:customerId/kyc/verify",
  ...guarded(
    Permission.CUSTOMER_KYC,
    validate({ body: kycVerifyBody }),
    idempotent,
    asyncHandler(controller.kyc(true)),
  ),
);
adminCustomerRouter.post(
  "/:customerId/block",
  ...guarded(
    Permission.CUSTOMER_BLOCK,
    validate({ body: customerBlockBody }),
    idempotent,
    asyncHandler(controller.block(true)),
  ),
);
adminCustomerRouter.post(
  "/:customerId/unblock",
  ...guarded(
    Permission.CUSTOMER_BLOCK,
    validate({ body: customerBlockBody }),
    idempotent,
    asyncHandler(controller.block(false)),
  ),
);
adminCustomerRouter.put(
  "/:customerId/nominee",
  ...guarded(
    Permission.CUSTOMER_WRITE,
    validate({ body: nomineeBody }),
    idempotent,
    asyncHandler(controller.nominee(false)),
  ),
);
adminCustomerRouter.get(
  "/:customerId/nominee",
  ...guarded(Permission.CUSTOMER_READ, asyncHandler(controller.nomineeDetail)),
);
adminCustomerRouter.delete(
  "/:customerId/nominee",
  ...guarded(Permission.CUSTOMER_WRITE, asyncHandler(controller.nominee(true))),
);
adminCustomerRouter.get(
  "/:customerId/statement",
  ...guarded(Permission.CUSTOMER_READ, asyncHandler(controller.statement)),
);
adminCustomerRouter.post(
  "/:customerId/statement/share-whatsapp",
  ...guarded(
    Permission.MESSAGE_SEND,
    idempotent,
    asyncHandler(controller.shareStatement),
  ),
);
