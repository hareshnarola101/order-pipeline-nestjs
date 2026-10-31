import { Injectable, Logger } from '@nestjs/common';
import { decodeCursor, encodeCursor } from './cursor';
import type { CreateOrderDto } from './dto/create-order.dto';
import type { ListOrdersQueryDto } from './dto/list-orders.query';
import { hashOrderRequest, normalizeLines } from './order-lines';
import {
  DuplicateIdempotencyKeyError,
  IdempotencyKeyReusedError,
  OrderNotFoundError,
} from './orders.errors';
import { OrdersRepository, type OrderWithItems } from './orders.repository';

export const ORDER_CURRENCY = 'USD';

export interface CreateOrderContext {
  idempotencyKey: string;
  correlationId: string;
}

export interface CreateOrderResult {
  order: OrderWithItems;
  /** True when the response is a replay of an earlier request with the same key. */
  replayed: boolean;
}

export interface OrderPage {
  orders: OrderWithItems[];
  nextCursor: string | null;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(private readonly repository: OrdersRepository) {}

  async create(dto: CreateOrderDto, context: CreateOrderContext): Promise<CreateOrderResult> {
    const requestHash = hashOrderRequest(dto);

    const existing = await this.repository.findByIdempotencyKey(context.idempotencyKey);
    if (existing) {
      return this.replay(existing, requestHash);
    }

    try {
      const order = await this.repository.createWithReservation({
        customerId: dto.customerId,
        currency: ORDER_CURRENCY,
        lines: normalizeLines(dto.items),
        paymentToken: dto.paymentToken,
        idempotencyKey: context.idempotencyKey,
        requestHash,
        correlationId: context.correlationId,
      });
      this.logger.log({ orderId: order.id, totalCents: order.totalCents }, 'Order created');
      return { order, replayed: false };
    } catch (error) {
      if (!(error instanceof DuplicateIdempotencyKeyError)) {
        throw error;
      }
      // A concurrent request with the same key committed first; answer with its order.
      const winner = await this.repository.findByIdempotencyKey(context.idempotencyKey);
      if (!winner) {
        throw error;
      }
      return this.replay(winner, requestHash);
    }
  }

  async findById(id: string): Promise<OrderWithItems> {
    const order = await this.repository.findById(id);
    if (!order) {
      throw new OrderNotFoundError(id);
    }
    return order;
  }

  async list(query: ListOrdersQueryDto): Promise<OrderPage> {
    const rows = await this.repository.list({
      limit: query.limit,
      status: query.status,
      cursor: query.cursor ? decodeCursor(query.cursor) : undefined,
    });
    const orders = rows.slice(0, query.limit);
    const last = orders.at(-1);
    const nextCursor = rows.length > query.limit && last ? encodeCursor(last) : null;
    return { orders, nextCursor };
  }

  private replay(order: OrderWithItems, requestHash: string): CreateOrderResult {
    if (order.requestHash !== requestHash) {
      throw new IdempotencyKeyReusedError();
    }
    return { order, replayed: true };
  }
}
