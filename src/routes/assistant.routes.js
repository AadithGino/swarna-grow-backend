import { Router } from "express";
import * as controller from "../controllers/assistant.controller.js";
import { asyncHandler } from "../lib/async-handler.js";
import { validate } from "../middlewares/validation.middleware.js";
import { cursorQuery, idParam } from "../validators/common.validators.js";
import {
  assistantChatBody,
  assistantExportBody,
  assistantRenameBody,
} from "../validators/assistant.validators.js";
import { Permission } from "../constants/permissions.js";
import { guarded } from "../lib/route.js";
import { assistantChatRateLimit } from "../middlewares/security.middleware.js";

export const assistantRouter = Router();

assistantRouter.post(
  "/chat",
  assistantChatRateLimit,
  ...guarded(
    Permission.REPORT_READ,
    validate({ body: assistantChatBody }),
    asyncHandler(controller.chat),
  ),
);

assistantRouter.post(
  "/export",
  ...guarded(
    Permission.REPORT_EXPORT,
    validate({ body: assistantExportBody }),
    asyncHandler(controller.exportResult),
  ),
);

assistantRouter.get(
  "/conversations",
  ...guarded(
    Permission.REPORT_READ,
    validate({ query: cursorQuery }),
    asyncHandler(controller.getConversations),
  ),
);

assistantRouter.get(
  "/conversations/:id/messages",
  ...guarded(
    Permission.REPORT_READ,
    validate({ params: idParam("id"), query: cursorQuery }),
    asyncHandler(controller.getMessages),
  ),
);

assistantRouter.delete(
  "/conversations/:id",
  ...guarded(
    Permission.REPORT_READ,
    validate({ params: idParam("id") }),
    asyncHandler(controller.removeConversation),
  ),
);

assistantRouter.patch(
  "/conversations/:id",
  ...guarded(
    Permission.REPORT_READ,
    validate({ params: idParam("id"), body: assistantRenameBody }),
    asyncHandler(controller.patchConversation),
  ),
);
