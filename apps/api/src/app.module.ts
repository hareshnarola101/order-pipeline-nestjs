import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { createLoggerModule, validateEnv } from '@app/common';
import { DatabaseModule } from '@app/database';
import { MessagingModule } from '@app/messaging';
import { ApiKeyGuard } from './auth/api-key.guard';
import { DomainExceptionFilter } from './common/domain-exception.filter';
import { ApiEnv } from './config/api-env';
import { HealthModule } from './health/health.module';
import { OrdersModule } from './orders/orders.module';
import { OutboxModule } from './outbox/outbox.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (config) => validateEnv(ApiEnv, config),
    }),
    createLoggerModule('api'),
    DatabaseModule,
    MessagingModule,
    HealthModule,
    OrdersModule,
    OutboxModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {}
