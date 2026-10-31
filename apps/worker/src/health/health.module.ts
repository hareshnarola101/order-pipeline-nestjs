import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { RabbitMqHealthIndicator } from '@app/messaging';
import { HealthController } from './health.controller';

@Module({
  imports: [TerminusModule.forRoot({ logger: false })],
  controllers: [HealthController],
  providers: [RabbitMqHealthIndicator],
})
export class HealthModule {}
