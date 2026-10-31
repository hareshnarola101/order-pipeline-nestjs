export const ORDER_STATUSES = ['PENDING', 'PAID', 'FAILED'] as const;
export type OrderStatusValue = (typeof ORDER_STATUSES)[number];

export interface OrderItemResponse {
  productId: string;
  quantity: number;
  unitPriceCents: number;
}

/** Public shape of an order. Internal columns (request hash, idempotency key) stay out. */
export interface OrderResponse {
  id: string;
  customerId: string;
  status: OrderStatusValue;
  totalCents: number;
  currency: string;
  paymentReference: string | null;
  failureReason: string | null;
  items: OrderItemResponse[];
  createdAt: string;
  updatedAt: string;
}

export interface OrderPageResponse {
  data: OrderResponse[];
  nextCursor: string | null;
}
