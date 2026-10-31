import type { OrderResponse } from './dto/order.response';
import type { OrderWithItems } from './orders.repository';

export function toOrderResponse(order: OrderWithItems): OrderResponse {
  return {
    id: order.id,
    customerId: order.customerId,
    status: order.status,
    totalCents: order.totalCents,
    currency: order.currency,
    paymentReference: order.paymentReference,
    failureReason: order.failureReason,
    items: order.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
    })),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}
