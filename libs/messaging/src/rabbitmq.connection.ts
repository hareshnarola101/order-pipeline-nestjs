import { Logger, OnApplicationShutdown } from '@nestjs/common';
import amqp, {
  type AmqpConnectionManager,
  type ChannelWrapper,
  type CreateChannelOpts,
} from 'amqp-connection-manager';

/**
 * Owns the single AMQP connection of a process. amqp-connection-manager
 * reconnects with a fixed delay and re-runs each channel's setup (topology,
 * consumers) after a reconnect, so callers never hold a dead channel.
 */
export class RabbitMqConnection implements OnApplicationShutdown {
  private readonly logger = new Logger(RabbitMqConnection.name);
  private readonly manager: AmqpConnectionManager;

  constructor(url: string) {
    this.manager = amqp.connect([url], {
      heartbeatIntervalInSeconds: 10,
      reconnectTimeInSeconds: 2,
    });
    this.manager.on('connect', () => this.logger.log('Connected to RabbitMQ'));
    this.manager.on('disconnect', ({ err }) =>
      this.logger.warn({ err }, 'Disconnected from RabbitMQ, reconnecting'),
    );
    this.manager.on('connectFailed', ({ err }) =>
      this.logger.warn({ err }, 'Could not connect to RabbitMQ, retrying'),
    );
  }

  createChannel(options: CreateChannelOpts): ChannelWrapper {
    return this.manager.createChannel(options);
  }

  isConnected(): boolean {
    return this.manager.isConnected();
  }

  // Channel owners close their channels in onModuleDestroy, which runs before this.
  async onApplicationShutdown(): Promise<void> {
    await this.manager.close();
  }
}
