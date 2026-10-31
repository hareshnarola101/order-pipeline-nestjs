import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChannelWrapper } from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import { PrismaService } from '@app/database';
import { assertOrdersTopology, ORDERS_EXCHANGE, RabbitMqConnection } from '@app/messaging';

interface PendingEvent {
  id: string;
  routingKey: string;
  payload: unknown;
  headers: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Publishes outbox rows to RabbitMQ. Because the row is written in the same
 * transaction as the order, an event is never lost if the broker is down or
 * the process dies between commit and publish; it is just published later.
 * Delivery is at-least-once, which is why the worker deduplicates by message id.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private channel?: ChannelWrapper;
  private timer?: NodeJS.Timeout;
  private currentRun: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitMqConnection,
    config: ConfigService,
  ) {
    this.pollIntervalMs = config.getOrThrow<number>('OUTBOX_POLL_INTERVAL_MS');
    this.batchSize = config.getOrThrow<number>('OUTBOX_BATCH_SIZE');
  }

  onApplicationBootstrap(): void {
    this.channel = this.rabbit.createChannel({
      name: 'outbox-publisher',
      confirm: true,
      publishTimeout: 5_000,
      setup: (channel: ConfirmChannel) => assertOrdersTopology(channel),
    });
    this.scheduleNext();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.currentRun;
    await this.channel?.close();
  }

  /**
   * Publishes one batch and returns how many events went out. `FOR UPDATE SKIP
   * LOCKED` lets several API replicas run the relay without publishing the same
   * row twice in the normal case.
   */
  async publishBatch(): Promise<number> {
    const channel = this.channel;
    if (!channel || !this.rabbit.isConnected()) {
      return 0;
    }

    return this.prisma.$transaction(
      async (tx) => {
        const events = await tx.$queryRaw<PendingEvent[]>`
          SELECT id, routing_key AS "routingKey", payload, headers, created_at AS "createdAt"
          FROM outbox_events
          WHERE published_at IS NULL
          ORDER BY created_at
          LIMIT ${this.batchSize}
          FOR UPDATE SKIP LOCKED`;

        const published: string[] = [];
        for (const event of events) {
          try {
            // Resolves only after the broker confirms the message is stored.
            await channel.publish(
              ORDERS_EXCHANGE,
              event.routingKey,
              Buffer.from(JSON.stringify(event.payload)),
              {
                messageId: event.id,
                type: event.routingKey,
                contentType: 'application/json',
                persistent: true,
                timestamp: Math.floor(event.createdAt.getTime() / 1000),
                headers: event.headers,
              },
            );
            published.push(event.id);
          } catch (error) {
            await tx.outboxEvent.update({
              where: { id: event.id },
              data: { attempts: { increment: 1 }, lastError: String(error) },
            });
            this.logger.warn({ err: error, eventId: event.id }, 'Failed to publish outbox event');
            break; // keep publish order; retry from this event on the next run
          }
        }

        if (published.length > 0) {
          await tx.outboxEvent.updateMany({
            where: { id: { in: published } },
            data: { publishedAt: new Date() },
          });
        }
        return published.length;
      },
      { timeout: 30_000 },
    );
  }

  private scheduleNext(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.currentRun = this.drain().finally(() => this.scheduleNext());
    }, this.pollIntervalMs);
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped && (await this.publishBatch()) === this.batchSize) {
        // a full batch usually means more rows are waiting
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Outbox relay run failed');
    }
  }
}
