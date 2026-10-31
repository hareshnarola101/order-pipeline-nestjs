import type { ConfigService } from '@nestjs/config';
import type { ConsumeMessage } from 'amqplib';
import {
  MessageHeaders,
  PAYMENT_DEAD_LETTER_QUEUE,
  type OrderCreatedEvent,
  type RabbitMqConnection,
} from '@app/messaging';
import { RetryPolicy } from '../messaging/retry-policy';
import { PaymentGatewayUnavailableError } from '../payments/payment-gateway';
import { OrderCreatedConsumer } from './order-created.consumer';
import type { OrderPaymentHandler } from './order-payment.handler';

const event: OrderCreatedEvent = {
  orderId: 'order-1',
  customerId: 'cust-1',
  totalCents: 100,
  currency: 'USD',
  paymentToken: 'tok_visa',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function message(body: unknown, headers: Record<string, unknown> = {}): ConsumeMessage {
  return {
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    fields: {} as ConsumeMessage['fields'],
    properties: { messageId: 'msg-1', headers } as unknown as ConsumeMessage['properties'],
  };
}

describe('OrderCreatedConsumer', () => {
  const channel = {
    consume: jest.fn(),
    sendToQueue: jest.fn(),
    ack: jest.fn(),
    nack: jest.fn(),
    cancelAll: jest.fn(),
    close: jest.fn(),
  };
  let handler: jest.Mocked<Pick<OrderPaymentHandler, 'handle' | 'compensate'>>;
  let consumer: OrderCreatedConsumer;

  beforeEach(async () => {
    jest.clearAllMocks();
    channel.sendToQueue.mockResolvedValue(true);
    handler = { handle: jest.fn().mockResolvedValue(undefined), compensate: jest.fn() };
    const rabbit = { createChannel: () => channel } as unknown as RabbitMqConnection;
    const config = { getOrThrow: () => 10 } as unknown as ConfigService;
    consumer = new OrderCreatedConsumer(
      rabbit,
      handler as unknown as OrderPaymentHandler,
      new RetryPolicy({ maxAttempts: 3, baseDelayMs: 100 }),
      config,
    );
    await consumer.onApplicationBootstrap();
  });

  it('acks after the handler succeeds', async () => {
    const msg = message(event, { [MessageHeaders.CorrelationId]: 'req-1' });

    await consumer.onMessage(msg);

    expect(handler.handle).toHaveBeenCalledWith(event, {
      messageId: 'msg-1',
      correlationId: 'req-1',
    });
    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('sends a failed first attempt to the first retry queue with attempt 2', async () => {
    handler.handle.mockRejectedValue(new PaymentGatewayUnavailableError());
    const msg = message(event);

    await consumer.onMessage(msg);

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      'orders.payment.retry.100ms',
      msg.content,
      expect.objectContaining({
        messageId: 'msg-1',
        persistent: true,
        headers: expect.objectContaining({ [MessageHeaders.Attempt]: 2 }),
      }),
    );
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it('backs off exponentially on later attempts', async () => {
    handler.handle.mockRejectedValue(new PaymentGatewayUnavailableError());

    await consumer.onMessage(message(event, { [MessageHeaders.Attempt]: 2 }));

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      'orders.payment.retry.200ms',
      expect.any(Buffer),
      expect.objectContaining({
        headers: expect.objectContaining({ [MessageHeaders.Attempt]: 3 }),
      }),
    );
  });

  it('compensates and dead-letters after the last attempt', async () => {
    handler.handle.mockRejectedValue(new PaymentGatewayUnavailableError());
    const msg = message(event, { [MessageHeaders.Attempt]: 3 });

    await consumer.onMessage(msg);

    expect(handler.compensate).toHaveBeenCalledWith(event);
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      PAYMENT_DEAD_LETTER_QUEUE,
      msg.content,
      expect.objectContaining({
        headers: expect.objectContaining({
          [MessageHeaders.DeadLetterReason]: 'max-attempts-exceeded',
        }),
      }),
    );
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it('dead-letters malformed messages without calling the handler', async () => {
    await consumer.onMessage(message('{not json'));

    expect(handler.handle).not.toHaveBeenCalled();
    expect(handler.compensate).not.toHaveBeenCalled();
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      PAYMENT_DEAD_LETTER_QUEUE,
      expect.any(Buffer),
      expect.objectContaining({
        headers: expect.objectContaining({ [MessageHeaders.DeadLetterReason]: 'non-retryable' }),
      }),
    );
  });

  it('still dead-letters when compensation fails', async () => {
    handler.handle.mockRejectedValue(new PaymentGatewayUnavailableError());
    handler.compensate.mockRejectedValue(new Error('db down'));
    const msg = message(event, { [MessageHeaders.Attempt]: 3 });

    await consumer.onMessage(msg);

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      PAYMENT_DEAD_LETTER_QUEUE,
      expect.any(Buffer),
      expect.anything(),
    );
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it('requeues the message if it cannot be handed off to a retry queue', async () => {
    handler.handle.mockRejectedValue(new PaymentGatewayUnavailableError());
    channel.sendToQueue.mockRejectedValue(new Error('broker unavailable'));
    const msg = message(event);

    await consumer.onMessage(msg);

    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
  });

  it('waits for in-flight messages before closing on shutdown', async () => {
    let finish!: () => void;
    handler.handle.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const onMessage = channel.consume.mock.calls[0][1] as (msg: ConsumeMessage) => void;
    onMessage(message(event));

    const shutdown = consumer.onModuleDestroy();
    await Promise.resolve();
    expect(channel.cancelAll).toHaveBeenCalled();
    expect(channel.close).not.toHaveBeenCalled();

    finish();
    await shutdown;
    expect(channel.close).toHaveBeenCalled();
  });
});
