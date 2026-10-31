import { Inject, Injectable, Logger } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import type { OrderCreatedEvent } from '@app/messaging';
import { NonRetryableError } from '../messaging/non-retryable.error';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../payments/payment-gateway';
import { OrderSettlementRepository, type MessageReceipt } from './order-settlement.repository';

export const PAYMENT_CONSUMER = 'order-payment';

/**
 * Business side of `order.created`: charge the customer, then settle the order.
 * It knows nothing about AMQP; errors it throws are retried by the consumer.
 */
@Injectable()
export class OrderPaymentHandler {
  private readonly logger = new Logger(OrderPaymentHandler.name);

  constructor(
    private readonly settlements: OrderSettlementRepository,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async handle(event: OrderCreatedEvent, messageId: string): Promise<void> {
    const receipt: MessageReceipt = { consumer: PAYMENT_CONSUMER, messageId };
    const context = { orderId: event.orderId, messageId };

    if (await this.settlements.isProcessed(receipt)) {
      this.logger.log(context, 'Duplicate message skipped');
      return;
    }

    const order = await this.settlements.findPayableOrder(event.orderId);
    if (!order) {
      throw new NonRetryableError(`Order ${event.orderId} does not exist`);
    }
    if (order.status !== OrderStatus.PENDING) {
      this.logger.log({ ...context, status: order.status }, 'Order already settled, skipping');
      return;
    }

    const result = await this.gateway.charge({
      orderId: order.id,
      amountCents: order.totalCents,
      currency: order.currency,
      paymentToken: event.paymentToken,
      idempotencyKey: order.id,
    });

    if (result.status === 'approved') {
      const outcome = await this.settlements.markPaid(order.id, result.transactionId, receipt);
      this.logger.log({ ...context, outcome, transactionId: result.transactionId }, 'Order paid');
    } else {
      const outcome = await this.settlements.markFailed(
        order.id,
        `payment_declined:${result.reason}`,
        receipt,
      );
      this.logger.log({ ...context, outcome, reason: result.reason }, 'Payment declined');
    }
  }

  /**
   * Called when the message is dead-lettered after exhausting retries. Holding
   * stock for an order we could not charge is worse than failing it, so the
   * order is failed and its stock released. The DLQ copy stays for inspection.
   */
  async compensate(event: OrderCreatedEvent): Promise<void> {
    const outcome = await this.settlements.markFailed(event.orderId, 'payment_retries_exhausted');
    this.logger.warn({ orderId: event.orderId, outcome }, 'Order failed after retries');
  }
}
