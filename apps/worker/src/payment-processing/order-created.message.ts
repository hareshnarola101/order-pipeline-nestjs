import type { ConsumeMessage } from 'amqplib';
import { MessageHeaders, type OrderCreatedEvent } from '@app/messaging';
import { NonRetryableError } from '../messaging/non-retryable.error';

function isOrderCreatedEvent(value: unknown): value is OrderCreatedEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    typeof event.orderId === 'string' &&
    typeof event.paymentToken === 'string' &&
    typeof event.totalCents === 'number' &&
    typeof event.currency === 'string'
  );
}

/** Malformed messages will never succeed, so they are flagged as non-retryable. */
export function parseOrderCreated(message: ConsumeMessage): OrderCreatedEvent {
  let body: unknown;
  try {
    body = JSON.parse(message.content.toString('utf8'));
  } catch {
    throw new NonRetryableError('Message body is not valid JSON');
  }
  if (!isOrderCreatedEvent(body)) {
    throw new NonRetryableError('Message body is not an order.created event');
  }
  return body;
}

/** Delivery count kept in our own header; the first delivery has no header and counts as 1. */
export function readAttempt(message: ConsumeMessage): number {
  const value = Number(message.properties.headers?.[MessageHeaders.Attempt] ?? 1);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

export function readCorrelationId(message: ConsumeMessage): string | undefined {
  const value: unknown = message.properties.headers?.[MessageHeaders.CorrelationId];
  return typeof value === 'string' ? value : undefined;
}
