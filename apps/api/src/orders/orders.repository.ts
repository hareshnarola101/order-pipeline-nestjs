import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, type OrderStatus } from '@prisma/client';
import { isUniqueViolation, PrismaService } from '@app/database';
import { MessageHeaders, RoutingKeys, type OrderCreatedEvent } from '@app/messaging';
import type { OrderCursor } from './cursor';
import type { OrderLine } from './order-lines';
import {
  DuplicateIdempotencyKeyError,
  InsufficientStockError,
  ProductNotFoundError,
} from './orders.errors';

export type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>;

export interface NewOrder {
  customerId: string;
  currency: string;
  lines: OrderLine[];
  paymentToken: string;
  idempotencyKey: string;
  requestHash: string;
  correlationId: string;
}

export interface OrderListFilter {
  limit: number;
  cursor?: OrderCursor;
  status?: OrderStatus;
}

@Injectable()
export class OrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<OrderWithItems | null> {
    return this.prisma.order.findUnique({ where: { id }, include: { items: true } });
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<OrderWithItems | null> {
    return this.prisma.order.findUnique({ where: { idempotencyKey }, include: { items: true } });
  }

  /** Newest first, keyset-paginated on (created_at, id). Fetches one extra row to detect a next page. */
  list({ limit, cursor, status }: OrderListFilter): Promise<OrderWithItems[]> {
    return this.prisma.order.findMany({
      where: {
        status,
        ...(cursor && {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { items: true },
    });
  }

  /**
   * Creates the order, reserves stock and records the `order.created` outbox
   * event in one transaction: either all of it happens or none of it does.
   *
   * Overselling is prevented by the conditional decrement
   *   UPDATE products SET stock = stock - $qty WHERE id = $id AND stock >= $qty
   * The UPDATE takes a row lock; a concurrent transaction on the same product
   * waits, then re-evaluates `stock >= $qty` against the committed value
   * (READ COMMITTED re-check). If no row matched, there was not enough stock.
   */
  async createWithReservation(input: NewOrder): Promise<OrderWithItems> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const productIds = input.lines.map((line) => line.productId);
        const products = await tx.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, priceCents: true },
        });
        const priceById = new Map(products.map((p) => [p.id, p.priceCents]));
        const missing = productIds.filter((id) => !priceById.has(id));
        if (missing.length > 0) {
          throw new ProductNotFoundError(missing);
        }

        const items = input.lines.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
          unitPriceCents: priceById.get(line.productId)!,
        }));
        const totalCents = items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);

        // Inserting first claims the idempotency key: a concurrent request with the
        // same key blocks on the unique index here and fails once this one commits.
        const order = await tx.order.create({
          data: {
            customerId: input.customerId,
            currency: input.currency,
            totalCents,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            items: { create: items },
          },
          include: { items: true },
        });

        // Lines arrive sorted by product id, so row locks are always taken in the same order.
        for (const line of input.lines) {
          const { count } = await tx.product.updateMany({
            where: { id: line.productId, stock: { gte: line.quantity } },
            data: { stock: { decrement: line.quantity } },
          });
          if (count === 0) {
            throw new InsufficientStockError(line.productId);
          }
        }

        const event: OrderCreatedEvent = {
          orderId: order.id,
          customerId: order.customerId,
          totalCents: order.totalCents,
          currency: order.currency,
          paymentToken: input.paymentToken,
          createdAt: order.createdAt.toISOString(),
        };
        await tx.outboxEvent.create({
          data: {
            id: randomUUID(),
            routingKey: RoutingKeys.OrderCreated,
            payload: event as unknown as Prisma.InputJsonObject,
            headers: { [MessageHeaders.CorrelationId]: input.correlationId },
          },
        });

        return order;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'idempotency_key')) {
        throw new DuplicateIdempotencyKeyError();
      }
      throw error;
    }
  }
}
