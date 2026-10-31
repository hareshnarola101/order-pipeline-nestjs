import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';

/**
 * The worker is a regular Nest app: the consumer starts on bootstrap, and the
 * HTTP server only exposes health probes for the orchestrator.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.listen(app.get(ConfigService).getOrThrow<number>('PORT'));
}

bootstrap().catch((error: unknown) => {
  console.error('Worker failed to start', error);
  process.exit(1);
});
