import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { API_KEY, createProduct, resetDatabase, startApi, waitFor } from './support/harness';

describe('Orders API (e2e)', () => {
  let app: INestApplication;
  let http: App;
  const prisma = new PrismaClient();

  const post = (body: object, key: string | null = randomUUID()) => {
    const req = request(http).post('/orders').set('x-api-key', API_KEY());
    return key ? req.set('Idempotency-Key', key).send(body) : req.send(body);
  };
  const get = (path: string) => request(http).get(path).set('x-api-key', API_KEY());
  const orderFor = (productId: string, quantity = 1, customerId = 'cust-1') => ({
    customerId,
    paymentToken: 'tok_visa',
    items: [{ productId, quantity }],
  });
  const stockOf = async (id: string) =>
    (await prisma.product.findUniqueOrThrow({ where: { id } })).stock;

  beforeAll(async () => {
    await resetDatabase(prisma);
    app = await startApi();
    http = app.getHttpServer() as App;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(() => resetDatabase(prisma));

  describe('auth and validation', () => {
    it('rejects requests without a valid API key', async () => {
      await request(http).get('/orders').expect(401);
      await request(http).get('/orders').set('x-api-key', 'wrong-key').expect(401);
    });

    it('keeps health endpoints public', async () => {
      await request(http).get('/health/live').expect(200);
      await waitFor(async () => (await request(http).get('/health')).status === 200);
    });

    it('requires an Idempotency-Key header', async () => {
      const product = await createProduct(prisma, 5);
      const res = await post(orderFor(product.id), null).expect(400);
      expect(res.body.message).toMatch(/Idempotency-Key/);
    });

    it('validates the body and rejects unknown fields', async () => {
      const product = await createProduct(prisma, 5);
      await post({ ...orderFor(product.id, 0) }).expect(400);
      await post({ ...orderFor(product.id), discount: 50 }).expect(400);
      await post({ customerId: 'c', paymentToken: 't', items: [] }).expect(400);
    });

    it('rejects unknown products', async () => {
      const res = await post(orderFor(randomUUID())).expect(422);
      expect(res.body.error).toBe('PRODUCT_NOT_FOUND');
    });
  });

  describe('creating orders', () => {
    it('creates a pending order, reserves stock and records an outbox event', async () => {
      const product = await createProduct(prisma, 10, 2500);

      const res = await post(orderFor(product.id, 3)).expect(201);

      expect(res.body).toMatchObject({
        status: 'PENDING',
        totalCents: 7500,
        currency: 'USD',
        items: [{ productId: product.id, quantity: 3, unitPriceCents: 2500 }],
      });
      expect(res.body).not.toHaveProperty('requestHash');
      expect(await stockOf(product.id)).toBe(7);

      const fetched = await get(`/orders/${res.body.id}`).expect(200);
      expect(fetched.body).toEqual(res.body);

      // The relay publishes the event shortly after the commit.
      const event = await waitFor(() =>
        prisma.outboxEvent.findFirst({ where: { publishedAt: { not: null } } }),
      );
      expect(event.routingKey).toBe('order.created');
      expect(event.payload).toMatchObject({ orderId: res.body.id, paymentToken: 'tok_visa' });
    });

    it('rolls back the whole reservation when one item is out of stock', async () => {
      const inStock = await createProduct(prisma, 10);
      const soldOut = await createProduct(prisma, 0);

      const res = await post({
        customerId: 'cust-1',
        paymentToken: 'tok_visa',
        items: [
          { productId: inStock.id, quantity: 2 },
          { productId: soldOut.id, quantity: 1 },
        ],
      }).expect(409);

      expect(res.body.error).toBe('INSUFFICIENT_STOCK');
      expect(await stockOf(inStock.id)).toBe(10);
      expect(await prisma.order.count()).toBe(0);
      expect(await prisma.outboxEvent.count()).toBe(0);
    });

    it('never oversells under concurrent requests', async () => {
      const product = await createProduct(prisma, 5);

      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, i) => post(orderFor(product.id, 1, `cust-${i}`))),
      );

      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(5);
      expect(statuses.filter((s) => s === 409)).toHaveLength(15);
      expect(await stockOf(product.id)).toBe(0);
      expect(await prisma.order.count()).toBe(5);
    });
  });

  describe('idempotency', () => {
    it('replays the original response for a retried request', async () => {
      const product = await createProduct(prisma, 10);
      const key = randomUUID();

      const first = await post(orderFor(product.id, 2), key).expect(201);
      const second = await post(orderFor(product.id, 2), key).expect(200);

      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.id).toBe(first.body.id);
      expect(await stockOf(product.id)).toBe(8);
      expect(await prisma.order.count()).toBe(1);
    });

    it('rejects a key reused with a different body', async () => {
      const product = await createProduct(prisma, 10);
      const key = randomUUID();

      await post(orderFor(product.id, 1), key).expect(201);
      const res = await post(orderFor(product.id, 4), key).expect(422);

      expect(res.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await stockOf(product.id)).toBe(9);
    });

    it('creates exactly one order when the same request arrives concurrently', async () => {
      const product = await createProduct(prisma, 10);
      const key = randomUUID();

      const responses = await Promise.all(
        Array.from({ length: 8 }, () => post(orderFor(product.id, 1), key)),
      );

      expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 200)).toHaveLength(7);
      expect(await stockOf(product.id)).toBe(9);
      expect(await prisma.order.count()).toBe(1);
    });
  });

  describe('reading orders', () => {
    it('returns 404 for an unknown order and 400 for a malformed id', async () => {
      const res = await get(`/orders/${randomUUID()}`).expect(404);
      expect(res.body.error).toBe('ORDER_NOT_FOUND');
      await get('/orders/not-a-uuid').expect(400);
    });

    it('pages through orders newest first with a cursor', async () => {
      const product = await createProduct(prisma, 100);
      for (let i = 0; i < 5; i++) {
        await post(orderFor(product.id)).expect(201);
      }
      // Orders created within the same millisecond are ordered by id, so ask the DB.
      const expected = await prisma.order.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await get(`/orders?limit=2${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
        const body = res.body as { data: { id: string }[]; nextCursor: string | null };
        seen.push(...body.data.map((o) => o.id));
        cursor = body.nextCursor;
        pages++;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toEqual(expected.map((o) => o.id));
    });

    it('filters by status and rejects a malformed cursor', async () => {
      const product = await createProduct(prisma, 10);
      await post(orderFor(product.id)).expect(201);

      const pending = await get('/orders?status=PENDING').expect(200);
      expect(pending.body.data).toHaveLength(1);
      const paid = await get('/orders?status=PAID').expect(200);
      expect(paid.body.data).toHaveLength(0);

      await get('/orders?cursor=garbage').expect(400);
      await get('/orders?limit=1000').expect(400);
    });
  });
});
