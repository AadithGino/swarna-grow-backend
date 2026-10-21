import { Router } from "express";
import { authRouter } from "./auth.routes.js";
import { publicRouter } from "./public.routes.js";
import { platformRouter } from "./platform.routes.js";
import { adminConfigRouter } from "./admin-config.routes.js";
import { adminCustomerRouter } from "./admin-customers.routes.js";
import { adminSchemeRouter } from "./admin-schemes.routes.js";
import { adminOperationsRouter } from "./admin-operations.routes.js";
import { adminAnalyticsRouter } from "./admin-analytics.routes.js";
import { adminEcommerceRouter } from "./admin-ecommerce.routes.js";
import { adminDigitalMetalsRouter } from "./admin-digital-metals.routes.js";
import { staffRouter } from "./staff.routes.js";
import { appRouter } from "./app.routes.js";
import { appAuthRouter } from "./app-auth.routes.js";
import { applyAgentCapabilities, authenticate, requireSubject, tenantScope } from "../middlewares/auth.middleware.js";
import { requirePlatformCapability } from "../middlewares/platform-capability.middleware.js";

export const apiRouter = Router();
apiRouter.use("/public", publicRouter); apiRouter.use("/auth", authRouter); apiRouter.use("/platform", platformRouter); apiRouter.use("/app/auth", appAuthRouter);
apiRouter.use("/admin/customers", authenticate, requireSubject("TENANT_USER"), tenantScope, adminCustomerRouter);
apiRouter.use("/admin", authenticate, requireSubject("TENANT_USER"), tenantScope, adminConfigRouter, adminSchemeRouter, adminOperationsRouter, adminAnalyticsRouter, adminEcommerceRouter, adminDigitalMetalsRouter);
apiRouter.use(
  "/staff",
  authenticate,
  requireSubject("TENANT_USER"),
  tenantScope,
  requirePlatformCapability("staffAppEnabled"),
  applyAgentCapabilities,
  staffRouter,
);
apiRouter.use(
  "/app",
  authenticate,
  requireSubject("CUSTOMER"),
  tenantScope,
  requirePlatformCapability("customerAppEnabled"),
  appRouter,
);
