export const MessageHeaders = {
  CorrelationId: 'x-correlation-id',
  Attempt: 'x-attempt',
  LastError: 'x-last-error',
  DeadLetterReason: 'x-dead-letter-reason',
} as const;

/** Payload of `order.created`. The message id is the outbox event id. */
export interface OrderCreatedEvent {
  orderId: string;
  customerId: string;
  totalCents: number;
  currency: string;
  paymentToken: string;
  createdAt: string;
}
