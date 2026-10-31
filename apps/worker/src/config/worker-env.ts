import { BaseEnv } from '@app/common';
import { IsInt, IsNumber, Max, Min } from 'class-validator';

export class WorkerEnv extends BaseEnv {
  /** Port for the health endpoints. */
  @IsInt()
  @Min(1)
  PORT: number = 3001;

  @IsInt()
  @Min(1)
  @Max(500)
  WORKER_PREFETCH: number = 10;

  /** Total deliveries per message, including the first one. */
  @IsInt()
  @Min(1)
  @Max(10)
  RETRY_MAX_ATTEMPTS: number = 4;

  @IsInt()
  @Min(10)
  RETRY_BASE_DELAY_MS: number = 1000;

  /** Probability (0-1) that a charge fails with a transient gateway error. */
  @IsNumber()
  @Min(0)
  @Max(1)
  FAKE_PAYMENT_FAILURE_RATE: number = 0;

  /** Probability (0-1) that a charge is declined. */
  @IsNumber()
  @Min(0)
  @Max(1)
  FAKE_PAYMENT_DECLINE_RATE: number = 0;

  @IsInt()
  @Min(0)
  FAKE_PAYMENT_LATENCY_MS: number = 50;
}
