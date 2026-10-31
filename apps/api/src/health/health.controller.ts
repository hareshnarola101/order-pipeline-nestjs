import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { PrismaService } from '@app/database';
import { RabbitMqHealthIndicator } from '@app/messaging';
import { Public } from '../auth/public.decorator';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly rabbitHealth: RabbitMqHealthIndicator,
  ) {}

  /** Liveness: the process is up and the event loop responds. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies are reachable. */
  @Get()
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
      () => this.rabbitHealth.isHealthy('rabbitmq'),
    ]);
  }
}
