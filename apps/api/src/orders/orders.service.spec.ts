import type { CreateOrderDto } from './dto/create-order.dto';
import { encodeCursor } from './cursor';
import { hashOrderRequest } from './order-lines';
import {
  DuplicateIdempotencyKeyError,
  IdempotencyKeyReusedError,
  InsufficientStockError,
  OrderNotFoundError,
} from './orders.errors';
import type { OrdersRepository, OrderWithItems } from './orders.repository';
import { OrdersService } from './orders.service';

const PRODUCT_A = '00000000-0000-4000-8000-00000000000a';
const PRODUCT_B = '00000000-0000-4000-8000-00000000000b';

const dto: CreateOrderDto = {
  customerId: 'cust-1',
  paymentToken: 'tok_visa',
  items: [
    { productId: PRODUCT_B, quantity: 1 },
    { productId: PRODUCT_A, quantity: 2 },
    { productId: PRODUCT_B, quantity: 3 },
  ],
};

function order(overrides: Partial<OrderWithItems> = {}): OrderWithItems {
  return {
    id: 'order-1',
    customerId: 'cust-1',
    status: 'PENDING',
    totalCents: 1000,
    currency: 'USD',
    idempotencyKey: 'key-1',
    requestHash: hashOrderRequest(dto),
    paymentReference: null,
    failureReason: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    items: [],
    ...overrides,
  };
}

describe('OrdersService', () => {
  let repository: jest.Mocked<
    Pick<OrdersRepository, 'findById' | 'findByIdempotencyKey' | 'list' | 'createWithReservation'>
  >;
  let service: OrdersService;
  const context = { idempotencyKey: 'key-1', correlationId: 'req-1' };

  beforeEach(() => {
    repository = {
      findById: jest.fn(),
      findByIdempotencyKey: jest.fn(),
      list: jest.fn(),
      createWithReservation: jest.fn(),
    };
    service = new OrdersService(repository as unknown as OrdersRepository);
  });

  describe('create', () => {
    it('creates an order with merged, sorted lines', async () => {
      repository.findByIdempotencyKey.mockResolvedValue(null);
      repository.createWithReservation.mockResolvedValue(order());

      const result = await service.create(dto, context);

      expect(result).toEqual({ order: order(), replayed: false });
      expect(repository.createWithReservation).toHaveBeenCalledWith({
        customerId: 'cust-1',
        currency: 'USD',
        paymentToken: 'tok_visa',
        idempotencyKey: 'key-1',
        correlationId: 'req-1',
        requestHash: hashOrderRequest(dto),
        lines: [
          { productId: PRODUCT_A, quantity: 2 },
          { productId: PRODUCT_B, quantity: 4 },
        ],
      });
    });

    it('replays the stored order when the same key and body are sent again', async () => {
      repository.findByIdempotencyKey.mockResolvedValue(order());

      const result = await service.create(dto, context);

      expect(result).toEqual({ order: order(), replayed: true });
      expect(repository.createWithReservation).not.toHaveBeenCalled();
    });

    it('rejects a reused key with a different body', async () => {
      repository.findByIdempotencyKey.mockResolvedValue(order({ requestHash: 'something-else' }));

      await expect(service.create(dto, context)).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
      expect(repository.createWithReservation).not.toHaveBeenCalled();
    });

    it('returns the winning order when a concurrent request claims the key first', async () => {
      repository.findByIdempotencyKey.mockResolvedValueOnce(null).mockResolvedValueOnce(order());
      repository.createWithReservation.mockRejectedValue(new DuplicateIdempotencyKeyError());

      const result = await service.create(dto, context);

      expect(result).toEqual({ order: order(), replayed: true });
    });

    it('propagates domain errors from the reservation', async () => {
      repository.findByIdempotencyKey.mockResolvedValue(null);
      repository.createWithReservation.mockRejectedValue(new InsufficientStockError(PRODUCT_A));

      await expect(service.create(dto, context)).rejects.toBeInstanceOf(InsufficientStockError);
    });
  });

  describe('findById', () => {
    it('throws when the order does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findById('missing')).rejects.toBeInstanceOf(OrderNotFoundError);
    });
  });

  describe('list', () => {
    it('returns a cursor pointing at the last row when there is another page', async () => {
      const rows = [order({ id: 'c' }), order({ id: 'b' }), order({ id: 'a' })];
      repository.list.mockResolvedValue(rows);

      const page = await service.list({ limit: 2 });

      expect(page.orders.map((o) => o.id)).toEqual(['c', 'b']);
      expect(page.nextCursor).toBe(encodeCursor(rows[1]));
      expect(repository.list).toHaveBeenCalledWith({
        limit: 2,
        cursor: undefined,
        status: undefined,
      });
    });

    it('returns no cursor on the last page', async () => {
      repository.list.mockResolvedValue([order({ id: 'a' })]);

      const page = await service.list({ limit: 2 });

      expect(page.nextCursor).toBeNull();
    });

    it('decodes the incoming cursor', async () => {
      repository.list.mockResolvedValue([]);
      const createdAt = new Date('2026-02-03T04:05:06.007Z');

      await service.list({ limit: 5, cursor: encodeCursor({ createdAt, id: 'x' }) });

      expect(repository.list).toHaveBeenCalledWith({
        limit: 5,
        status: undefined,
        cursor: { createdAt, id: 'x' },
      });
    });
  });
});
