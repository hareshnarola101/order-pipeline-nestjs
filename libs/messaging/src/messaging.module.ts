import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RabbitMqConnection } from './rabbitmq.connection';

@Global()
@Module({
  providers: [
    {
      provide: RabbitMqConnection,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new RabbitMqConnection(config.getOrThrow<string>('RABBITMQ_URL')),
    },
  ],
  exports: [RabbitMqConnection],
})
export class MessagingModule {}
