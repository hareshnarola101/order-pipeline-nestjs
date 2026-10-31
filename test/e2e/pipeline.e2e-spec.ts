import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import amqplib from 'amqplib';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  MessageHeaders,
  ORDERS_EXCHANGE,
  PAYMENT_DEAD_LETTER_QUEUE,
  RoutingKeys,
  type OrderCreatedEvent,
} from '@app/messaging';
import { OrderPaymentHandler } from '../../apps/worker/src/payment-processing/order-payment.handler';
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
} from '../../apps/worker/src/payments/payment-gateway';
import {
  API_KEY,
  createProduct,
  drainQueue,
  purgeQueues,
  resetDatabase,
  startApi,
  startWorker,
  waitFor,
} from './support/harness';

interface OrderBody {
  id: string;
  status: string;
  paymentReference: string | null;
  failureReason: string | null;
}

describe('Order pipeline: API -> RabbitMQ -> worker (e2e)', () => {
  let api: INestApplication;
  let worker: INestApplication;
  let http: App;
  const prisma = new PrismaClient();

  const createOrder = async (productId: string, paymentToken: string, quantity = 1) => {
    const res = await request(http)
      .post('/orders')
      .set('x-api-key', API_KEY())
      .set('Idempotency-Key', randomUUID())
      .send({ customerId: 'cust-1', paymentToken, items: [{ productId, quantity }] })
      .expect(201);
    return res.body as OrderBody;
  };

  const waitForStatus = (orderId: string, status: 'PAID' | 'FAILED') =>
    waitFor(async () => {
      const res = await request(http).get(`/orders/${orderId}`).set('x-api-key', API_KEY());
      const body = res.body as OrderBody;
      return body.status === status ? body : undefined;
    });

  const stockOf = async (id: string) =>
    (await prisma.product.findUniqueOrThrow({ where: { id } })).stock;

  beforeAll(async () => {
    await resetDatabase(prisma);
    await purgeQueues();
    api = await startApi();
    worker = await startWorker();
    http = api.getHttpServer() as App;
  });

  afterAll(async () => {
    await worker.close();
    await api.close();
    await prisma.$disconnect();
  });

  afterEach(() => jest.restoreAllMocks());

  it('charges a new order and marks it PAID', async () => {
    const product = await createProduct(prisma, 10, 4200);

    const order = await createOrder(product.id, 'tok_visa', 2);
    const paid = await waitForStatus(order.id, 'PAID');

    expect(paid.paymentReference).toMatch(/^txn_/);
    expect(paid.failureReason).toBeNull();
    expect(await stockOf(product.id)).toBe(8);
    expect(await prisma.processedMessage.count({ where: { consumer: 'order-payment' } })).toBe(1);
  });

  it('fails a declined order and releases its stock', async () => {
    const product = await createProduct(prisma, 10);

    const order = await createOrder(product.id, 'tok_decline', 3);
    const failed = await waitForStatus(order.id, 'FAILED');

    expect(failed.failureReason).toBe('payment_declined:card_declined');
    expect(await stockOf(product.id)).toBe(10);
  });

  it('retries transient gateway errors with backoff, then dead-letters the message', async () => {
    const product = await createProduct(prisma, 10);
    const charge = jest.spyOn(worker.get<PaymentGateway>(PAYMENT_GATEWAY), 'charge');
    const startedAt = Date.now();

    const order = await createOrder(product.id, 'tok_unavailable', 4);
    const failed = await waitForStatus(order.id, 'FAILED');

    // RETRY_MAX_ATTEMPTS=3 and RETRY_BASE_DELAY_MS=200: attempts at ~0ms, ~200ms, ~600ms.
    expect(charge).toHaveBeenCalledTimes(3);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(600);
    expect(failed.failureReason).toBe('payment_retries_exhausted');
    expect(await stockOf(product.id)).toBe(10);

    const deadLetters = await waitFor(async () => {
      const messages = await drainQueue(PAYMENT_DEAD_LETTER_QUEUE);
      return messages.length > 0 ? messages : undefined;
    });
    expect(deadLetters).toHaveLength(1);
    const [dead] = deadLetters;
    expect(JSON.parse(dead.content.toString())).toMatchObject({ orderId: order.id });
    expect(dead.properties.headers).toMatchObject({
      [MessageHeaders.Attempt]: 3,
      [MessageHeaders.DeadLetterReason]: 'max-attempts-exceeded',
      [MessageHeaders.LastError]: 'Payment gateway unavailable',
    });
  });

  it('skips a message that was already processed instead of charging again', async () => {
    const product = await createProduct(prisma, 10);
    const order = await prisma.order.create({
      data: {
        customerId: 'cust-1',
        totalCents: 1000,
        currency: 'USD',
        idempotencyKey: randomUUID(),
        requestHash: 'manual',
        items: { create: [{ productId: product.id, quantity: 1, unitPriceCents: 1000 }] },
      },
    });
    const messageId = randomUUID();
    await prisma.processedMessage.create({ data: { consumer: 'order-payment', messageId } });

    const handler = worker.get(OrderPaymentHandler);
    const handle = handler.handle.bind(handler);
    const handled = new Promise<void>((resolve) => {
      jest.spyOn(handler, 'handle').mockImplementationOnce(async (...args) => {
        await handle(...args);
        resolve();
      });
    });
    const charge = jest.spyOn(worker.get<PaymentGateway>(PAYMENT_GATEWAY), 'charge');

    const event: OrderCreatedEvent = {
      orderId: order.id,
      customerId: order.customerId,
      totalCents: order.totalCents,
      currency: order.currency,
      paymentToken: 'tok_visa',
      createdAt: order.createdAt.toISOString(),
    };
    const connection = await amqplib.connect(process.env.RABBITMQ_URL!);
    const channel = await connection.createConfirmChannel();
    channel.publish(ORDERS_EXCHANGE, RoutingKeys.OrderCreated, Buffer.from(JSON.stringify(event)), {
      messageId,
      persistent: true,
    });
    await channel.waitForConfirms();
    await connection.close();

    await handled;
    expect(charge).not.toHaveBeenCalled();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      'PENDING',
    );
  });
});
