import type { Channel } from 'amqplib';

export const ORDERS_EXCHANGE = 'orders';

export const RoutingKeys = {
  OrderCreated: 'order.created',
} as const;

export const PAYMENT_QUEUE = 'orders.payment';
export const PAYMENT_DEAD_LETTER_QUEUE = 'orders.payment.dlq';

/** One retry queue per delay, e.g. `orders.payment.retry.2000ms`. */
export function retryQueueName(queue: string, delayMs: number): string {
  return `${queue}.retry.${delayMs}ms`;
}

/**
 * Declares the exchange, the payment work queue and its dead-letter queue.
 * Both apps call this: the API so an event published before the worker has
 * ever started is still routed to a queue instead of being dropped.
 */
export async function assertOrdersTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(ORDERS_EXCHANGE, 'topic', { durable: true });
  await channel.assertQueue(PAYMENT_QUEUE, { durable: true });
  await channel.bindQueue(PAYMENT_QUEUE, ORDERS_EXCHANGE, RoutingKeys.OrderCreated);
  await channel.assertQueue(PAYMENT_DEAD_LETTER_QUEUE, { durable: true });
}

/**
 * Delayed-retry queues. Nothing consumes them: a message sits there until its
 * TTL expires, then RabbitMQ dead-letters it back onto the work queue via the
 * default exchange. Each queue has a single fixed TTL, so messages expire in
 * FIFO order and a long delay never blocks a short one.
 */
export async function assertRetryQueues(
  channel: Channel,
  queue: string,
  delaysMs: readonly number[],
): Promise<void> {
  for (const delayMs of new Set(delaysMs)) {
    await channel.assertQueue(retryQueueName(queue, delayMs), {
      durable: true,
      arguments: {
        'x-message-ttl': delayMs,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': queue,
      },
    });
  }
}
