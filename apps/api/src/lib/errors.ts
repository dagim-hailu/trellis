export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "Authentication required") {
    super(401, "unauthorized", message);
  }
}

export class ValidationError extends ApiError {
  constructor(message = "Invalid request") {
    super(400, "validation_error", message);
  }
}

export class NotFoundApiError extends ApiError {
  constructor(message = "Resource not found") {
    super(404, "not_found", message);
  }
}

export class ForbiddenApiError extends ApiError {
  constructor(message = "Insufficient permissions") {
    super(403, "forbidden", message);
  }
}

export class ConflictApiError extends ApiError {
  constructor(message = "Resource already exists") {
    super(409, "conflict", message);
  }
}
