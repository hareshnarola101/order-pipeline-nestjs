import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

const MAX_LENGTH = 255;

/** Reads and validates the required `Idempotency-Key` request header. */
export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const key = ctx.switchToHttp().getRequest<Request>().header('idempotency-key')?.trim();
  if (!key) {
    throw new BadRequestException('The Idempotency-Key header is required');
  }
  if (key.length > MAX_LENGTH) {
    throw new BadRequestException(`Idempotency-Key must be at most ${MAX_LENGTH} characters`);
  }
  return key;
});
