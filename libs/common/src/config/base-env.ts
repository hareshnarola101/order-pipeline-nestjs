import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Settings shared by every app in the repo. */
export class BaseEnv {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  RABBITMQ_URL!: string;

  @IsIn(LOG_LEVELS)
  LOG_LEVEL: LogLevel = 'info';
}
