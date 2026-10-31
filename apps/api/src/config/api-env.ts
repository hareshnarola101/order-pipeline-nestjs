import { BaseEnv } from '@app/common';
import { IsInt, IsString, Max, Min, MinLength } from 'class-validator';

export class ApiEnv extends BaseEnv {
  @IsInt()
  @Min(1)
  PORT = 3000;

  @IsString()
  @MinLength(16)
  API_KEY!: string;

  @IsInt()
  @Min(50)
  OUTBOX_POLL_INTERVAL_MS = 500;

  @IsInt()
  @Min(1)
  @Max(500)
  OUTBOX_BATCH_SIZE = 50;
}
