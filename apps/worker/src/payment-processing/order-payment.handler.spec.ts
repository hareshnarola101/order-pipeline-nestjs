import type { OrderCreatedEvent } from '@app/messaging';
import { NonRetryableError } from '../messaging/non-retryable.error';
import { PaymentGatewayUnavailableError, type PaymentGateway } from '../payments/payment-gateway';
import { OrderPaymentHandler, PAYMENT_CONSUMER } from './order-payment.handler';
import type { OrderSettlementRepository, PayableOrder } from './order-settlement.repository';

const event: OrderCreatedEvent = {
  orderId: 'order-1',
  customerId: 'cust-1',
  totalCents: 2500,
  currency: 'USD',
  paymentToken: 'tok_visa',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const pendingOrder: PayableOrder = {
  id: 'order-1',
  status: 'PENDING',
  totalCents: 2500,
  currency: 'USD',
};
const receipt = { consumer: PAYMENT_CONSUMER, messageId: 'msg-1' };

describe('OrderPaymentHandler', () => {
  let settlements: jest.Mocked<
    Pick<OrderSettlementRepository, 'isProcessed' | 'findPayableOrder' | 'markPaid' | 'markFailed'>
  >;
  let gateway: jest.Mocked<PaymentGateway>;
  let handler: OrderPaymentHandler;

  beforeEach(() => {
    settlements = {
      isProcessed: jest.fn().mockResolvedValue(false),
      findPayableOrder: jest.fn().mockResolvedValue(pendingOrder),
      markPaid: jest.fn().mockResolvedValue('settled'),
      markFailed: jest.fn().mockResolvedValue('settled'),
    };
    gateway = { charge: jest.fn() };
    handler = new OrderPaymentHandler(settlements as unknown as OrderSettlementRepository, gateway);
  });

  it('charges the stored amount and marks the order paid', async () => {
    gateway.charge.mockResolvedValue({ status: 'approved', transactionId: 'txn_1' });

    await handler.handle(event, { messageId: 'msg-1' });

    expect(gateway.charge).toHaveBeenCalledWith({
      orderId: 'order-1',
      amountCents: 2500,
      currency: 'USD',
      paymentToken: 'tok_visa',
      idempotencyKey: 'order-1',
    });
    expect(settlements.markPaid).toHaveBeenCalledWith('order-1', 'txn_1', receipt);
  });

  it('fails the order when the payment is declined', async () => {
    gateway.charge.mockResolvedValue({ status: 'declined', reason: 'card_declined' });

    await handler.handle(event, { messageId: 'msg-1' });

    expect(settlements.markFailed).toHaveBeenCalledWith(
      'order-1',
      'payment_declined:card_declined',
      receipt,
    );
    expect(settlements.markPaid).not.toHaveBeenCalled();
  });

  it('skips a message it has already processed without charging again', async () => {
    settlements.isProcessed.mockResolvedValue(true);

    await handler.handle(event, { messageId: 'msg-1' });

    expect(settlements.isProcessed).toHaveBeenCalledWith(receipt);
    expect(gateway.charge).not.toHaveBeenCalled();
  });

  it('skips orders that are no longer pending', async () => {
    settlements.findPayableOrder.mockResolvedValue({ ...pendingOrder, status: 'PAID' });

    await handler.handle(event, { messageId: 'msg-1' });

    expect(gateway.charge).not.toHaveBeenCalled();
  });

  it('does not retry when the order does not exist', async () => {
    settlements.findPayableOrder.mockResolvedValue(null);

    await expect(handler.handle(event, { messageId: 'msg-1' })).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  it('lets transient gateway errors bubble up so the message is retried', async () => {
    gateway.charge.mockRejectedValue(new PaymentGatewayUnavailableError());

    await expect(handler.handle(event, { messageId: 'msg-1' })).rejects.toBeInstanceOf(
      PaymentGatewayUnavailableError,
    );
    expect(settlements.markFailed).not.toHaveBeenCalled();
  });

  it('fails the order and releases stock when compensating', async () => {
    await handler.compensate(event);

    expect(settlements.markFailed).toHaveBeenCalledWith('order-1', 'payment_retries_exhausted');
  });
});
