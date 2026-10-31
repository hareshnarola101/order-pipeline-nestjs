export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export interface ChargeRequest {
  orderId: string;
  amountCents: number;
  currency: string;
  paymentToken: string;
  /** Lets the provider collapse duplicate charges if we retry after a crash. */
  idempotencyKey: string;
}

export type ChargeResult =
  { status: 'approved'; transactionId: string } | { status: 'declined'; reason: string };

/**
 * A decline is a normal business outcome and is returned. Infrastructure
 * problems (timeouts, 5xx) are thrown as PaymentGatewayUnavailableError so the
 * caller can retry them.
 */
export interface PaymentGateway {
  charge(request: ChargeRequest): Promise<ChargeResult>;
}

export class PaymentGatewayUnavailableError extends Error {
  constructor(message = 'Payment gateway unavailable') {
    super(message);
    this.name = 'PaymentGatewayUnavailableError';
  }
}
