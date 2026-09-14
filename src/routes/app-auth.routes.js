import { Router } from "express";
import * as controller from "../controllers/auth.controller.js";
import { asyncHandler } from "../lib/async-handler.js";
import { authenticate, requireSubject } from "../middlewares/auth.middleware.js";

export const appAuthRouter = Router();
appAuthRouter.post("/refresh", asyncHandler(controller.refresh));
appAuthRouter.post("/logout", authenticate, requireSubject("CUSTOMER"), asyncHandler(controller.logout));
appAuthRouter.get("/me", authenticate, requireSubject("CUSTOMER"), asyncHandler(controller.me));
