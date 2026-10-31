import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListOrdersQueryDto } from './dto/list-orders.query';
import type { OrderPageResponse, OrderResponse } from './dto/order.response';
import { IdempotencyKey } from './idempotency-key.decorator';
import { toOrderResponse } from './order.mapper';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  async create(
    @Body() dto: CreateOrderDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderResponse> {
    const { order, replayed } = await this.orders.create(dto, {
      idempotencyKey,
      // pino-http assigns a string id (from X-Request-Id or a new UUID) to every request.
      correlationId: typeof req.id === 'string' ? req.id : randomUUID(),
    });
    if (replayed) {
      res.status(200).setHeader('Idempotent-Replayed', 'true');
    } else {
      res.status(201);
    }
    return toOrderResponse(order);
  }

  @Get(':id')
  async findOne(@Param('id', new ParseUUIDPipe()) id: string): Promise<OrderResponse> {
    return toOrderResponse(await this.orders.findById(id));
  }

  @Get()
  async list(@Query() query: ListOrdersQueryDto): Promise<OrderPageResponse> {
    const page = await this.orders.list(query);
    return { data: page.orders.map(toOrderResponse), nextCursor: page.nextCursor };
  }
}
