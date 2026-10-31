import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetryPolicy } from '../messaging/retry-policy';
import { PaymentsModule } from '../payments/payments.module';
import { OrderCreatedConsumer } from './order-created.consumer';
import { OrderPaymentHandler } from './order-payment.handler';
import { OrderSettlementRepository } from './order-settlement.repository';

@Module({
  imports: [PaymentsModule],
  providers: [
    OrderCreatedConsumer,
    OrderPaymentHandler,
    OrderSettlementRepository,
    {
      provide: RetryPolicy,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new RetryPolicy({
          maxAttempts: config.getOrThrow<number>('RETRY_MAX_ATTEMPTS'),
          baseDelayMs: config.getOrThrow<number>('RETRY_BASE_DELAY_MS'),
        }),
    },
  ],
})
export class PaymentProcessingModule {}
