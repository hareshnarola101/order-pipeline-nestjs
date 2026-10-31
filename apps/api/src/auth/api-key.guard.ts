import { createHash, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC } from './public.decorator';

const digest = (value: string) => createHash('sha256').update(value).digest();

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    this.expected = digest(config.getOrThrow<string>('API_KEY'));
  }

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const provided = context.switchToHttp().getRequest<Request>().header('x-api-key');
    // Hashing both sides gives equal-length buffers, which timingSafeEqual requires.
    if (!provided || !timingSafeEqual(digest(provided), this.expected)) {
      throw new UnauthorizedException('Missing or invalid API key');
    }
    return true;
  }
}
