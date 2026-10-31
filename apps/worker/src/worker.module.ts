import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { createLoggerModule, validateEnv } from '@app/common';
import { DatabaseModule } from '@app/database';
import { MessagingModule } from '@app/messaging';
import { WorkerEnv } from './config/worker-env';
import { HealthModule } from './health/health.module';
import { PaymentProcessingModule } from './payment-processing/payment-processing.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (config) => validateEnv(WorkerEnv, config),
    }),
    createLoggerModule('worker'),
    DatabaseModule,
    MessagingModule,
    HealthModule,
    PaymentProcessingModule,
  ],
})
export class WorkerModule {}
