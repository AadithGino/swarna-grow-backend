export class FcmSendDeferredError extends Error {
  constructor(retryAfterMs, scope = "rate_limit") {
    super(`FCM send deferred (${scope})`);
    this.name = "FcmSendDeferredError";
    this.retryAfterMs = Math.max(250, Number(retryAfterMs) || 1000);
    this.scope = scope;
  }
}
