import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';

/** Shared by main.ts and the e2e tests so both run the same pipeline. */
export function configureApp(app: INestApplication): INestApplication {
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();
  return app;
}
