import { FakePaymentGateway, FakePaymentTokens } from './fake-payment.gateway';
import { PaymentGatewayUnavailableError, type ChargeRequest } from './payment-gateway';

const request = (overrides: Partial<ChargeRequest> = {}): ChargeRequest => ({
  orderId: 'order-1',
  amountCents: 1000,
  currency: 'USD',
  paymentToken: 'tok_visa',
  idempotencyKey: 'order-1',
  ...overrides,
});

describe('FakePaymentGateway', () => {
  const quiet = { failureRate: 0, declineRate: 0, latencyMs: 0 };

  it('approves by default', async () => {
    const result = await new FakePaymentGateway(quiet).charge(request());
    expect(result).toEqual({ status: 'approved', transactionId: expect.stringMatching(/^txn_/) });
  });

  it('declines the decline test token', async () => {
    const result = await new FakePaymentGateway(quiet).charge(
      request({ paymentToken: FakePaymentTokens.Decline }),
    );
    expect(result).toEqual({ status: 'declined', reason: 'card_declined' });
  });

  it('throws a transient error for the unavailable test token', async () => {
    await expect(
      new FakePaymentGateway(quiet).charge(
        request({ paymentToken: FakePaymentTokens.Unavailable }),
      ),
    ).rejects.toBeInstanceOf(PaymentGatewayUnavailableError);
  });

  it('fails according to the configured failure rate', async () => {
    const gateway = new FakePaymentGateway({ ...quiet, failureRate: 0.5, random: () => 0.4 });
    await expect(gateway.charge(request())).rejects.toBeInstanceOf(PaymentGatewayUnavailableError);
  });

  it('returns the same result for the same idempotency key', async () => {
    const gateway = new FakePaymentGateway(quiet);
    const first = await gateway.charge(request());
    const second = await gateway.charge(request());
    expect(second).toEqual(first);
  });
});
