import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = configureApp(await NestFactory.create(AppModule, { bufferLogs: true }));
  await app.listen(app.get(ConfigService).getOrThrow<number>('PORT'));
}

bootstrap().catch((error: unknown) => {
  console.error('API failed to start', error);
  process.exit(1);
});
