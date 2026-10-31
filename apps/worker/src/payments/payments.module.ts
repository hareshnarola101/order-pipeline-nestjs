import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FakePaymentGateway } from './fake-payment.gateway';
import { PAYMENT_GATEWAY } from './payment-gateway';

/** Swap the factory for a real provider client; nothing else depends on the implementation. */
@Module({
  providers: [
    {
      provide: PAYMENT_GATEWAY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new FakePaymentGateway({
          failureRate: config.getOrThrow<number>('FAKE_PAYMENT_FAILURE_RATE'),
          declineRate: config.getOrThrow<number>('FAKE_PAYMENT_DECLINE_RATE'),
          latencyMs: config.getOrThrow<number>('FAKE_PAYMENT_LATENCY_MS'),
        }),
    },
  ],
  exports: [PAYMENT_GATEWAY],
})
export class PaymentsModule {}
