/**
 * Customer realtime channel (Socket.IO).
 * Auth: Bearer access token (CUSTOMER only). Rooms: customer:{tenantId}:{customerId}
 */
import { Server } from "socket.io";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { UserType } from "../constants/enums.js";
import { verifyAccessToken } from "../services/token.service.js";

/** @type {import("socket.io").Server | null} */
let io = null;

export const CustomerSocketEvent = Object.freeze({
  REDEMPTION_HANDOVER_OTP_RELEASED: "redemption.handover_otp_released",
  SHOP_PICKUP_CODE_RELEASED: "shop.pickup_code_released",
});

export function customerRoom(tenantId, customerId) {
  return `customer:${tenantId}:${customerId}`;
}

export function getCustomerIo() {
  return io;
}

export function attachCustomerSocket(httpServer) {
  if (io) return io;
  io = new Server(httpServer, {
    path: "/realtime",
    cors: {
      origin: env.corsOrigins?.length ? env.corsOrigins : true,
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  io.use((socket, next) => {
    try {
      const raw =
        socket.handshake.auth?.token
        ?? socket.handshake.headers?.authorization
        ?? "";
      const token = String(raw).replace(/^Bearer\s+/i, "").trim();
      if (!token) return next(new Error("UNAUTHENTICATED"));
      const claims = verifyAccessToken(token);
      const type = claims.typ;
      const customerId = type === UserType.CUSTOMER ? claims.sub : null;
      const tenantId = claims.tid;
      if (type !== UserType.CUSTOMER || !customerId || !tenantId) {
        return next(new Error("FORBIDDEN"));
      }
      socket.data.auth = { tenantId, customerId, type: UserType.CUSTOMER };
      return next();
    } catch (err) {
      return next(err);
    }
  });

  io.on("connection", (socket) => {
    const { tenantId, customerId } = socket.data.auth;
    const room = customerRoom(tenantId, customerId);
    socket.join(room);
    logger.debug({ tenantId, customerId, sid: socket.id }, "Customer socket connected");
    socket.on("disconnect", (reason) => {
      logger.debug({ tenantId, customerId, sid: socket.id, reason }, "Customer socket disconnected");
    });
  });

  logger.info({ path: "/realtime" }, "Customer Socket.IO attached");
  return io;
}

/**
 * Emit to a customer's room. Never throws — realtime is best-effort.
 */
export function emitToCustomer(tenantId, customerId, event, payload) {
  try {
    if (!io || !tenantId || !customerId || !event) return false;
    io.to(customerRoom(tenantId, customerId)).emit(event, payload);
    return true;
  } catch (err) {
    logger.warn({ err, tenantId, customerId, event }, "Customer socket emit failed");
    return false;
  }
}
