import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { stdTimeFunctions } from 'pino';

const REQUEST_ID_HEADER = 'x-request-id';

function requestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/**
 * JSON logs with a service name and a request id on every line. Request logs
 * carry method, url and status only, so headers such as X-Api-Key never reach the logs.
 */
export function createLoggerModule(service: string): DynamicModule {
  return LoggerModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (config: ConfigService) => ({
      pinoHttp: {
        level: config.get<string>('LOG_LEVEL', 'info'),
        base: { service },
        timestamp: stdTimeFunctions.isoTime,
        formatters: { level: (label: string) => ({ level: label }) },
        serializers: {
          req: (req: IncomingMessage & { id?: unknown }) => ({
            id: req.id,
            method: req.method,
            url: req.url,
          }),
          res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
        },
        genReqId: requestId,
        autoLogging: { ignore: (req: IncomingMessage) => req.url?.startsWith('/health') ?? false },
      },
    }),
  });
}
