import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChannelWrapper } from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import {
  assertOrdersTopology,
  assertRetryQueues,
  MessageHeaders,
  PAYMENT_DEAD_LETTER_QUEUE,
  PAYMENT_QUEUE,
  RabbitMqConnection,
  retryQueueName,
  type OrderCreatedEvent,
} from '@app/messaging';
import { NonRetryableError } from '../messaging/non-retryable.error';
import { RetryPolicy } from '../messaging/retry-policy';
import { parseOrderCreated, readAttempt } from './order-created.message';
import { OrderPaymentHandler } from './order-payment.handler';

/**
 * AMQP side of payment processing: manual acks, delayed retries and the DLQ.
 *
 * A message is acked only after its outcome is safely recorded somewhere:
 * the database (success), a retry queue, or the DLQ. If handing it off fails,
 * it is nacked and RabbitMQ redelivers it.
 */
@Injectable()
export class OrderCreatedConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OrderCreatedConsumer.name);
  private readonly inFlight = new Set<Promise<void>>();
  private readonly prefetch: number;
  private channel?: ChannelWrapper;

  constructor(
    private readonly rabbit: RabbitMqConnection,
    private readonly handler: OrderPaymentHandler,
    private readonly retryPolicy: RetryPolicy,
    config: ConfigService,
  ) {
    this.prefetch = config.getOrThrow<number>('WORKER_PREFETCH');
  }

  async onApplicationBootstrap(): Promise<void> {
    this.channel = this.rabbit.createChannel({
      name: 'order-payment-consumer',
      confirm: true,
      publishTimeout: 5_000,
      setup: async (channel: ConfirmChannel) => {
        await assertOrdersTopology(channel);
        await assertRetryQueues(channel, PAYMENT_QUEUE, this.retryPolicy.delaysMs);
      },
    });
    // Registers the consumer; it starts (and restarts after a reconnect) once the channel is up.
    await this.channel.consume(PAYMENT_QUEUE, (message) => this.track(this.onMessage(message)), {
      prefetch: this.prefetch,
    });
  }

  /** Graceful shutdown: stop taking deliveries, finish in-flight ones, then close. */
  async onModuleDestroy(): Promise<void> {
    if (!this.channel) {
      return;
    }
    await this.channel.cancelAll();
    if (this.inFlight.size > 0) {
      this.logger.log({ inFlight: this.inFlight.size }, 'Waiting for in-flight messages');
      await Promise.allSettled(this.inFlight);
    }
    await this.channel.close();
  }

  async onMessage(message: ConsumeMessage): Promise<void> {
    const attempt = readAttempt(message);
    let event: OrderCreatedEvent | undefined;
    try {
      event = parseOrderCreated(message);
      const messageId = message.properties.messageId as string | undefined;
      if (!messageId) {
        throw new NonRetryableError('Message has no messageId');
      }
      await this.handler.handle(event, messageId);
      this.channel?.ack(message);
    } catch (error) {
      await this.onFailure(message, attempt, event, error);
    }
  }

  private async onFailure(
    message: ConsumeMessage,
    attempt: number,
    event: OrderCreatedEvent | undefined,
    error: unknown,
  ): Promise<void> {
    const channel = this.channel!;
    const decision = this.retryPolicy.decide(attempt, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const context = { messageId: message.properties.messageId as unknown, orderId: event?.orderId };

    try {
      if (decision.action === 'retry') {
        await channel.sendToQueue(
          retryQueueName(PAYMENT_QUEUE, decision.delayMs),
          message.content,
          this.republishOptions(message, {
            [MessageHeaders.Attempt]: decision.nextAttempt,
            [MessageHeaders.LastError]: errorMessage,
          }),
        );
        this.logger.warn(
          { ...context, attempt, delayMs: decision.delayMs, error: errorMessage },
          'Processing failed, scheduled retry',
        );
      } else {
        if (event) {
          await this.compensate(event);
        }
        await channel.sendToQueue(
          PAYMENT_DEAD_LETTER_QUEUE,
          message.content,
          this.republishOptions(message, {
            [MessageHeaders.Attempt]: attempt,
            [MessageHeaders.LastError]: errorMessage,
            [MessageHeaders.DeadLetterReason]: decision.reason,
          }),
        );
        this.logger.error(
          { ...context, attempt, reason: decision.reason, error: errorMessage },
          'Message dead-lettered',
        );
      }
      channel.ack(message);
    } catch (handOffError) {
      this.logger.error({ ...context, err: handOffError }, 'Could not hand off failed message');
      channel.nack(message, false, true);
    }
  }

  /** Best effort: the message still goes to the DLQ if compensation fails. */
  private async compensate(event: OrderCreatedEvent): Promise<void> {
    try {
      await this.handler.compensate(event);
    } catch (error) {
      this.logger.error({ orderId: event.orderId, err: error }, 'Compensation failed');
    }
  }

  private republishOptions(
    message: ConsumeMessage,
    headers: Record<string, unknown>,
  ): Options.Publish {
    const { properties } = message;
    return {
      persistent: true,
      messageId: properties.messageId as string | undefined,
      type: properties.type as string | undefined,
      contentType: properties.contentType as string | undefined,
      timestamp: properties.timestamp as number | undefined,
      headers: { ...properties.headers, ...headers },
    };
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }
}
