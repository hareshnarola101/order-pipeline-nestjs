import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  PaymentGatewayUnavailableError,
  type ChargeRequest,
  type ChargeResult,
  type PaymentGateway,
} from './payment-gateway';

export interface FakePaymentGatewayOptions {
  failureRate: number;
  declineRate: number;
  latencyMs: number;
  random?: () => number;
}

/** Test tokens, in the spirit of the ones card processors publish. */
export const FakePaymentTokens = {
  Decline: 'tok_decline',
  Unavailable: 'tok_unavailable',
} as const;

/**
 * In-memory stand-in for a card processor. Behaviour is driven by the token
 * (deterministic, used by the e2e tests) or by configured failure/decline rates
 * (for load and chaos testing). Like a real provider it remembers results per
 * idempotency key, so a retried charge does not charge twice.
 */
export class FakePaymentGateway implements PaymentGateway {
  private readonly results = new Map<string, ChargeResult>();
  private readonly random: () => number;

  constructor(private readonly options: FakePaymentGatewayOptions) {
    this.random = options.random ?? Math.random;
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    if (this.options.latencyMs > 0) {
      await sleep(this.options.latencyMs);
    }

    const previous = this.results.get(request.idempotencyKey);
    if (previous) {
      return previous;
    }

    if (
      request.paymentToken === FakePaymentTokens.Unavailable ||
      this.random() < this.options.failureRate
    ) {
      throw new PaymentGatewayUnavailableError();
    }

    const result: ChargeResult =
      request.paymentToken === FakePaymentTokens.Decline || this.random() < this.options.declineRate
        ? { status: 'declined', reason: 'card_declined' }
        : { status: 'approved', transactionId: `txn_${randomUUID()}` };

    this.results.set(request.idempotencyKey, result);
    return result;
  }
}
