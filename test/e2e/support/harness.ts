import { setTimeout as sleep } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import amqplib from 'amqplib';
import { AppModule } from '../../../apps/api/src/app.module';
import { configureApp } from '../../../apps/api/src/app.setup';
import { WorkerModule } from '../../../apps/worker/src/worker.module';
import {
  assertOrdersTopology,
  assertRetryQueues,
  PAYMENT_DEAD_LETTER_QUEUE,
  PAYMENT_QUEUE,
  retryQueueName,
} from '@app/messaging';
import { RetryPolicy } from '../../../apps/worker/src/messaging/retry-policy';

export const API_KEY = () => process.env.API_KEY!;

export async function startApi(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication({ bufferLogs: true }));
  // Listening once up front lets supertest fire concurrent requests at the same server.
  await app.listen(0, '127.0.0.1');
  return app;
}

export async function startWorker(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE order_items, orders, outbox_events, processed_messages, products CASCADE',
  );
}

export function createProduct(prisma: PrismaClient, stock: number, priceCents = 1000) {
  return prisma.product.create({
    data: {
      sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
      name: 'Test product',
      priceCents,
      stock,
    },
  });
}

function retryPolicyFromEnv(): RetryPolicy {
  return new RetryPolicy({
    maxAttempts: Number(process.env.RETRY_MAX_ATTEMPTS),
    baseDelayMs: Number(process.env.RETRY_BASE_DELAY_MS),
  });
}

async function withChannel<T>(work: (channel: amqplib.Channel) => Promise<T>): Promise<T> {
  const connection = await amqplib.connect(process.env.RABBITMQ_URL!);
  try {
    const channel = await connection.createChannel();
    const result = await work(channel);
    await channel.close();
    return result;
  } finally {
    await connection.close();
  }
}

/** Empties every queue the pipeline uses so suites do not see each other's messages. */
export function purgeQueues(): Promise<void> {
  return withChannel(async (channel) => {
    const { delaysMs } = retryPolicyFromEnv();
    await assertOrdersTopology(channel);
    await assertRetryQueues(channel, PAYMENT_QUEUE, delaysMs);
    const queues = [
      PAYMENT_QUEUE,
      PAYMENT_DEAD_LETTER_QUEUE,
      ...delaysMs.map((delay) => retryQueueName(PAYMENT_QUEUE, delay)),
    ];
    for (const queue of queues) {
      await channel.purgeQueue(queue);
    }
  });
}

/** Removes and returns every message currently in a queue. */
export function drainQueue(queue: string): Promise<amqplib.GetMessage[]> {
  return withChannel(async (channel) => {
    const messages: amqplib.GetMessage[] = [];
    for (let msg = await channel.get(queue); msg; msg = await channel.get(queue)) {
      messages.push(msg);
      channel.ack(msg);
    }
    return messages;
  });
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false>,
  { timeoutMs = 15_000, intervalMs = 100 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) {
      return value;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
