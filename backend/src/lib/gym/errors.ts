/**
 * Errors of the business logic. Routes map them onto HTTP status codes
 * (see routes/tenant/[tenantId]/gym/_shared.ts); the logic itself never
 * knows about HTTP.
 */

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

/** The request is well-formed but violates a rule of the domain. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** The input is not acceptable (missing field, bad value). */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

/** A service GYM depends on failed or refused (the image model, for example). */
export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

/** The mobile token is unknown or expired. */
export class TokenError extends Error {
  constructor(message = "This link is no longer valid") {
    super(message);
    this.name = "TokenError";
  }
}
