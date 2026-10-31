export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class OrderNotFoundError extends DomainError {
  readonly code = 'ORDER_NOT_FOUND';

  constructor(orderId: string) {
    super(`Order ${orderId} not found`);
  }
}

export class ProductNotFoundError extends DomainError {
  readonly code = 'PRODUCT_NOT_FOUND';

  constructor(readonly productIds: string[]) {
    super(`Unknown product(s): ${productIds.join(', ')}`);
  }
}

export class InsufficientStockError extends DomainError {
  readonly code = 'INSUFFICIENT_STOCK';

  constructor(readonly productId: string) {
    super(`Not enough stock for product ${productId}`);
  }
}

export class IdempotencyKeyReusedError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';

  constructor() {
    super('This Idempotency-Key was already used with a different request body');
  }
}

export class InvalidCursorError extends DomainError {
  readonly code = 'INVALID_CURSOR';

  constructor() {
    super('The pagination cursor is malformed');
  }
}

/** Internal signal from the repository: another request inserted the same key first. */
export class DuplicateIdempotencyKeyError extends Error {}
