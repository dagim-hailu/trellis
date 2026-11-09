export class DataError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class NotFoundError extends DataError {
  constructor(message = "Resource not found") {
    super("not_found", message);
  }
}

export class ForbiddenError extends DataError {
  constructor(message = "Insufficient permissions") {
    super("forbidden", message);
  }
}

export class ConflictError extends DataError {
  constructor(message = "Resource already exists") {
    super("conflict", message);
  }
}

export class InvalidTokenError extends DataError {
  constructor(message = "Invitation token is invalid or expired") {
    super("invalid_token", message);
  }
}

export class StorageError extends DataError {
  constructor(message = "Database operation failed", options?: ErrorOptions) {
    super("storage_error", message, options);
  }
}

export function isPgUniqueViolation(error: unknown): boolean {
  return isRecord(error) && error["code"] === "23505";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
