import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { RabbitMqConnection } from './rabbitmq.connection';

/** Provide this in an app's health module next to TerminusModule. */
@Injectable()
export class RabbitMqHealthIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    private readonly connection: RabbitMqConnection,
  ) {}

  isHealthy(key: string) {
    const indicator = this.indicators.check(key);
    return this.connection.isConnected()
      ? indicator.up()
      : indicator.down({ message: 'Not connected to RabbitMQ' });
  }
}
