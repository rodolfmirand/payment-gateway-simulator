/** Errors rendered with the exact bodies returned by the Pagar.me API (see docs/pagarme/reference/erros-1.md). */
export abstract class PagarmeError extends Error {
  abstract readonly statusCode: number;
  abstract toBody(): Record<string, unknown>;
}

abstract class MessageError extends PagarmeError {
  toBody(): Record<string, unknown> {
    return { message: this.message };
  }
}

export class BadRequestError extends MessageError {
  readonly statusCode = 400;
}

export class UnauthorizedError extends MessageError {
  readonly statusCode = 401;
  constructor() {
    super('Authorization has been denied for this request.');
  }
}

/** `new NotFoundError('Customer')` -> 404 {"message": "Customer not found."} */
export class NotFoundError extends MessageError {
  readonly statusCode = 404;
  constructor(resource: string) {
    super(`${resource} not found.`);
  }
}

export class PreconditionFailedError extends MessageError {
  readonly statusCode = 412;
}

export type FieldErrors = Record<string, string[]>;

/** 422 {"message": "The request is invalid.", "errors": {...}, "request": <body as sent>} */
export class ValidationError extends PagarmeError {
  readonly statusCode = 422;
  constructor(
    readonly errors: FieldErrors,
    readonly request: unknown,
  ) {
    super('The request is invalid.');
  }

  toBody(): Record<string, unknown> {
    return { message: this.message, errors: this.errors, request: this.request ?? {} };
  }
}
