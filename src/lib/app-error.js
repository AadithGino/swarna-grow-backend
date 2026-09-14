export class AppError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const errors = Object.freeze({
  validation: (details) => new AppError("VALIDATION_FAILED", "Please correct the highlighted fields.", 400, details),
  unauthenticated: (message = "Authentication is required.") => new AppError("UNAUTHENTICATED", message, 401),
  forbidden: (message = "You do not have permission to perform this action.") => new AppError("FORBIDDEN", message, 403),
  notFound: (resource = "Resource") => new AppError("RESOURCE_NOT_FOUND", `${resource} was not found.`, 404),
  conflict: (code, message) => new AppError(code, message, 409),
  business: (code, message, details) => new AppError(code, message, 422, details),
  dependency: (message) => new AppError("DEPENDENCY_UNAVAILABLE", message, 503),
});
