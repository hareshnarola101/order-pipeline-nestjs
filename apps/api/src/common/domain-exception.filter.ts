import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import {
  DomainError,
  IdempotencyKeyReusedError,
  InsufficientStockError,
  InvalidCursorError,
  OrderNotFoundError,
  ProductNotFoundError,
} from '../orders/orders.errors';

const STATUS_BY_ERROR = new Map<new (...args: never[]) => DomainError, HttpStatus>([
  [OrderNotFoundError, HttpStatus.NOT_FOUND],
  [ProductNotFoundError, HttpStatus.UNPROCESSABLE_ENTITY],
  [InsufficientStockError, HttpStatus.CONFLICT],
  [IdempotencyKeyReusedError, HttpStatus.UNPROCESSABLE_ENTITY],
  [InvalidCursorError, HttpStatus.BAD_REQUEST],
]);

/** Maps domain errors to HTTP responses so services stay free of HTTP concerns. */
@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: DomainError, host: ArgumentsHost): void {
    const status =
      STATUS_BY_ERROR.get(error.constructor as new () => DomainError) ??
      HttpStatus.UNPROCESSABLE_ENTITY;

    host.switchToHttp().getResponse<Response>().status(status).json({
      statusCode: status,
      error: error.code,
      message: error.message,
    });
  }
}
