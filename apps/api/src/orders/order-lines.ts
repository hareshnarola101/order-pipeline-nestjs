import { createHash } from 'node:crypto';
import type { CreateOrderDto, OrderItemDto } from './dto/create-order.dto';

export interface OrderLine {
  productId: string;
  quantity: number;
}

/**
 * Merges repeated products and sorts by product id. Sorting matters: every
 * transaction then locks product rows in the same order, which rules out
 * deadlocks between two multi-item orders.
 */
export function normalizeLines(items: readonly OrderItemDto[]): OrderLine[] {
  const quantities = new Map<string, number>();
  for (const { productId, quantity } of items) {
    quantities.set(productId, (quantities.get(productId) ?? 0) + quantity);
  }
  return [...quantities.entries()]
    .map(([productId, quantity]) => ({ productId, quantity }))
    .sort((a, b) => a.productId.localeCompare(b.productId));
}

/**
 * Fingerprint of what the client asked for. Two bodies that mean the same
 * order (items in a different order, a product split over two lines) hash equal.
 */
export function hashOrderRequest(dto: CreateOrderDto): string {
  const canonical = JSON.stringify({
    customerId: dto.customerId,
    paymentToken: dto.paymentToken,
    items: normalizeLines(dto.items),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
