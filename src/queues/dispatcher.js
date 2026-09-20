import { logger } from "../config/logger.js";
import { runDispatchCycle } from "../services/dispatch.service.js";

let timer;

async function dispatch() {
  try {
    await runDispatchCycle();
  } catch (error) {
    logger.error({ err: error }, "Outbox dispatch failed");
  }
}

export function startDispatcher() {
  if (!timer) {
    timer = setInterval(() => void dispatch(), 2000);
    timer.unref();
    void dispatch();
  }
}
export function stopDispatcher() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
