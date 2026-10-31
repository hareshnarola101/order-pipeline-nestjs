# order-pipeline-nestjs

[![CI](https://github.com/hareshnarola101/order-pipeline-nestjs/actions/workflows/ci.yml/badge.svg)](https://github.com/hareshnarola101/order-pipeline-nestjs/actions/workflows/ci.yml)

An order-processing backend split into an HTTP API and a background worker that talk over RabbitMQ.
I built it to show how I handle the parts of e-commerce backends that tend to go wrong in production:
retried requests that charge twice, concurrent checkouts that oversell stock, events that get lost
between the database and the broker, and messages that fail and need to be retried without blocking
everything else.

Stack: Node 22, TypeScript (strict), NestJS 11, PostgreSQL with Prisma, RabbitMQ (amqplib +
amqp-connection-manager), pino logs, Jest and Supertest, Docker and GitHub Actions.

## What it does

- **`POST /orders`** creates an order. It requires an `Idempotency-Key` header, so a client can retry
  after a timeout without creating a second order. Stock is reserved in the same database transaction.
- **`GET /orders/:id`** and **`GET /orders`** read orders back. The list uses cursor (keyset) pagination
  and can filter by status.
- The API writes an `order.created` event to an outbox table in the same transaction as the order. A
  relay publishes it to a RabbitMQ topic exchange.
- The **worker** consumes the event, charges the customer through a `PaymentGateway` interface (a fake
  implementation that can be told to decline or fail), then marks the order `PAID` or `FAILED`. A failed
  order gets its stock back.
- Transient failures are retried with exponential backoff through delayed retry queues. Messages that
  still fail end up in a dead-letter queue.
- Both apps log JSON with pino and expose `/health` (readiness) and `/health/live` (liveness).

## Architecture

```mermaid
flowchart LR
    client([Client]) -- "POST /orders + Idempotency-Key" --> controller

    subgraph api [apps/api]
        controller[OrdersController] --> service[OrdersService] --> repo[OrdersRepository]
        relay[OutboxRelay]
    end

    repo -- "one transaction: order, stock, outbox row" --> pg[(PostgreSQL)]
    relay -- "poll unpublished rows" --> pg
    relay -- "publish with confirms" --> exchange{{"orders exchange (topic)"}}
    exchange -- "order.created" --> queue[orders.payment]

    subgraph worker [apps/worker]
        consumer[OrderCreatedConsumer] --> handler[OrderPaymentHandler] --> gateway[PaymentGateway]
    end

    queue --> consumer
    handler -- "PAID or FAILED, release stock, inbox row" --> pg
    consumer -- "transient failure" --> retry[orders.payment.retry.Nms]
    retry -- "TTL expires" --> queue
    consumer -- "attempts exhausted" --> dlq[orders.payment.dlq]
```

The repo is a NestJS monorepo with one `package.json`:

```
apps/
  api/        HTTP API: orders module, outbox relay, API-key guard, health
  worker/     RabbitMQ consumer, retry policy, payment gateway, health
libs/
  common/     env validation, pino logger setup
  database/   PrismaService, Prisma error helpers
  messaging/  RabbitMQ connection, topology (exchange and queues), event contracts
prisma/       schema, migrations, demo seed data
test/e2e/     end-to-end tests that boot both apps against real Postgres and RabbitMQ
```

## Order lifecycle

```mermaid
stateDiagram-v2
    [*] --> PENDING: order created, stock reserved
    PENDING --> PAID: charge approved
    PENDING --> FAILED: declined or retries exhausted, stock released
    PAID --> [*]
    FAILED --> [*]
```

An order only leaves `PENDING` through a conditional update (`WHERE status = 'PENDING'`), so it moves
at most once, and stock is released only by the transaction that made the move to `FAILED`.

## Message flow, retries and the DLQ

```mermaid
flowchart TD
    deliver[Delivered from orders.payment] --> handle{Handler result}
    handle -- success --> ack[ack]
    handle -- "malformed message or unknown order" --> dlq
    handle -- "transient error, e.g. gateway timeout" --> more{"attempt < max?"}
    more -- yes --> retry["send to orders.payment.retry.Nms with x-attempt + 1, then ack"]
    retry -- "TTL expires, dead-lettered back via the default exchange" --> deliver
    more -- no --> compensate[mark order FAILED, release stock]
    compensate --> dlq["send to orders.payment.dlq with the reason and last error, then ack"]
```

- There is one retry queue per delay (`orders.payment.retry.1000ms`, `...2000ms`, `...4000ms`). Nothing
  consumes them. Each has a fixed `x-message-ttl` and dead-letters expired messages back to
  `orders.payment`. The delay before attempt `n + 1` is `RETRY_BASE_DELAY_MS * 2^(n - 1)`.
- The attempt number travels in an `x-attempt` header. `RetryPolicy` is a small pure class that turns
  `(attempt, error)` into "retry after N ms" or "dead-letter", which keeps it easy to unit test.
- Acks are manual. A message is acked only after its outcome is stored somewhere durable: the database,
  a retry queue or the DLQ, the last two through a confirm channel. If that hand-off fails, the message is
  nacked and redelivered.

## Quickstart

You need Docker with Compose v2.

```bash
git clone https://github.com/hareshnarola101/order-pipeline-nestjs.git
cd order-pipeline-nestjs
docker compose up --build
```

This starts Postgres, RabbitMQ, a one-off `migrate` job (applies migrations and loads three demo
products), the API and the worker.

| Service     | URL                                                | Notes                                  |
| ----------- | -------------------------------------------------- | -------------------------------------- |
| API         | http://localhost:3000                              | API key: `local-dev-api-key-change-me` |
| Worker      | http://localhost:3001/health                       | health probes only                     |
| RabbitMQ UI | http://localhost:15673                             | `guest` / `guest`                      |
| PostgreSQL  | `postgresql://orders:orders@localhost:5433/orders` |                                        |

Postgres and RabbitMQ are mapped to non-default host ports (5433, 5673, 15673) so they don't clash with
a locally installed Postgres or RabbitMQ. Every host port can be changed with an environment variable,
for example `API_PORT=8080 docker compose up`.

To watch the worker deal with an unreliable payment provider, start it with random failures:

```bash
FAKE_PAYMENT_FAILURE_RATE=0.5 docker compose up --build
```

## API examples

The seeded products are:

| id                                     | sku    | price  | stock |
| -------------------------------------- | ------ | ------ | ----- |
| `8f1c2a4e-6b1d-4c39-9a51-0d7a3f6e2b11` | KB-001 | 89.00  | 100   |
| `2b7e9c1a-3f4d-4e8b-8c2a-5d6f7a8b9c22` | MS-002 | 29.00  | 250   |
| `c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e33` | MN-003 | 329.00 | 5     |

**Create an order**

```bash
curl -i -X POST http://localhost:3000/orders \
  -H 'x-api-key: local-dev-api-key-change-me' \
  -H 'Idempotency-Key: 5d3f0c1e-checkout-42' \
  -H 'Content-Type: application/json' \
  -d '{
        "customerId": "cust-42",
        "paymentToken": "tok_visa",
        "items": [
          { "productId": "8f1c2a4e-6b1d-4c39-9a51-0d7a3f6e2b11", "quantity": 2 },
          { "productId": "2b7e9c1a-3f4d-4e8b-8c2a-5d6f7a8b9c22", "quantity": 1 }
        ]
      }'
```

```http
HTTP/1.1 201 Created
x-request-id: 4b2cf654-b0f7-4bf5-9fe5-4bf27c17f160

{
  "id": "beeaaa82-a4c6-42cb-bde1-cc1dffdf163b",
  "customerId": "cust-42",
  "status": "PENDING",
  "totalCents": 20700,
  "currency": "USD",
  "paymentReference": null,
  "failureReason": null,
  "items": [
    { "productId": "2b7e9c1a-3f4d-4e8b-8c2a-5d6f7a8b9c22", "quantity": 1, "unitPriceCents": 2900 },
    { "productId": "8f1c2a4e-6b1d-4c39-9a51-0d7a3f6e2b11", "quantity": 2, "unitPriceCents": 8900 }
  ],
  "createdAt": "2026-10-31T12:57:52.400Z",
  "updatedAt": "2026-10-31T12:57:52.400Z"
}
```

Sending the same request again with the same key returns `200 OK`, the same order and an
`Idempotent-Replayed: true` header. Sending a different body with that key returns
`422 IDEMPOTENCY_KEY_REUSED`.

**Fetch it again a moment later**

```bash
curl http://localhost:3000/orders/beeaaa82-a4c6-42cb-bde1-cc1dffdf163b \
  -H 'x-api-key: local-dev-api-key-change-me'
```

```json
{ "id": "beeaaa82-...", "status": "PAID", "paymentReference": "txn_3de4c38a-...", "...": "..." }
```

**List orders, newest first**

```bash
curl 'http://localhost:3000/orders?limit=20&status=PAID' -H 'x-api-key: local-dev-api-key-change-me'
# => { "data": [ ... ], "nextCursor": "WyIyMDI2LTEwLTMxVDEy..." }

curl 'http://localhost:3000/orders?limit=20&cursor=WyIyMDI2LTEwLTMxVDEy...' \
  -H 'x-api-key: local-dev-api-key-change-me'
```

**Payment test tokens**

| `paymentToken`    | What the fake gateway does                | Final status                                |
| ----------------- | ----------------------------------------- | ------------------------------------------- |
| anything else     | approves                                  | `PAID`                                      |
| `tok_decline`     | declines the card                         | `FAILED` (`payment_declined:card_declined`) |
| `tok_unavailable` | throws a transient error on every attempt | `FAILED` (`payment_retries_exhausted`), DLQ |

**Errors**

| Status | `error`                  | When                                            |
| ------ | ------------------------ | ----------------------------------------------- |
| 400    | -                        | invalid body, missing `Idempotency-Key`, bad id |
| 401    | -                        | missing or wrong `x-api-key`                    |
| 404    | `ORDER_NOT_FOUND`        | unknown order id                                |
| 409    | `INSUFFICIENT_STOCK`     | not enough stock for one of the items           |
| 422    | `PRODUCT_NOT_FOUND`      | unknown product id                              |
| 422    | `IDEMPOTENCY_KEY_REUSED` | same key, different request body                |

## How double charges and overselling are prevented

### Idempotent order creation

The `Idempotency-Key` is stored on the order in a column with a unique index, together with a SHA-256
hash of the normalized request body (items merged and sorted, so `[A, B]` and `[B, A]` hash the same).

1. If an order with that key exists and the hash matches, the API returns it with `200` and
   `Idempotent-Replayed: true`. If the hash differs, it returns `422`.
2. Otherwise it opens a transaction and inserts the order first. Two concurrent requests with the same
   key both get here; the second one blocks on the unique index until the first commits, then fails with
   a unique violation. Its whole transaction rolls back, including any stock it touched, and the service
   answers with the order the first request created.

The e2e suite sends the same request eight times in parallel and checks that exactly one order exists and
stock moved once.

### No overselling

Stock is reserved with a conditional update, one per product, inside the order transaction:

```sql
UPDATE products SET stock = stock - $qty WHERE id = $id AND stock >= $qty
```

The `UPDATE` takes a row lock. A concurrent transaction on the same product waits for that lock, and
under `READ COMMITTED` Postgres re-evaluates `stock >= $qty` against the newly committed row before
updating. If no row matches, there wasn't enough stock: the service throws, the transaction rolls back,
and the client gets `409`. A `CHECK (stock >= 0)` constraint backs this up at the schema level.

I chose this over `SELECT ... FOR UPDATE` followed by an update because it is one round trip per product
and the check and the write can't drift apart. It also avoids `SERIALIZABLE`, which would need retry
logic for serialization failures. Line items are sorted by product id first, so two multi-item orders
always lock rows in the same order and can't deadlock.

The e2e suite fires 20 concurrent orders at a product with 5 units and checks for exactly five `201`s,
fifteen `409`s and a final stock of zero.

### Exactly-once effects on top of at-least-once delivery

The outbox relay and RabbitMQ both deliver at least once, so the worker has to tolerate duplicates:

- Every message carries a stable `messageId` (the outbox row id). The worker records
  `(consumer, messageId)` in a `processed_messages` table in the same transaction as the status change,
  and skips messages it has already recorded.
- The status change itself is conditional on `status = 'PENDING'`, so even without the inbox row an order
  can't be settled twice or have its stock released twice.
- The charge happens before that transaction, so a crash in between would charge again on redelivery.
  The worker passes the order id as the payment provider's idempotency key, which is how real providers
  close that gap. The fake gateway honours it too.

## Running the tests

With Node 22 installed locally:

```bash
npm ci
npm run lint        # ESLint + Prettier check
npm run typecheck
npm test            # unit tests, no infrastructure needed

docker compose up -d postgres rabbitmq
npm run test:e2e    # applies migrations to orders_test, then runs the e2e suites
```

Without Node 22 on the host, run the same commands in a container on the Compose network:

```bash
docker compose up -d postgres rabbitmq
docker run --rm --network order-pipeline_default -v "$PWD":/app -w /app \
  -e DATABASE_URL=postgresql://orders:orders@postgres:5432/orders_test \
  -e RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672 \
  node:22 sh -c "npm ci && npm test && npm run test:e2e"
```

What is covered:

- **Unit tests** (45): `OrdersService` (create, replay, key reuse, concurrent key race, pagination),
  request hashing and line normalization, cursor encoding, `RetryPolicy`, `OrderPaymentHandler`
  (paid, declined, duplicate message, already settled, missing order), `OrderCreatedConsumer` (ack,
  retry routing and backoff, DLQ, malformed messages, nack when the hand-off fails, graceful shutdown)
  and the fake gateway.
- **E2E tests** (18): boot the real API and worker modules in-process against Postgres and RabbitMQ.
  They cover auth and validation, the concurrent oversell and idempotency scenarios above, partial-stock
  rollback, cursor pagination, the outbox relay, an order going all the way to `PAID`, a declined order
  releasing stock, an order that is retried with backoff and lands in the DLQ with `x-attempt: 3`, and a
  redelivered message being skipped without a second charge.

CI runs lint, typecheck and unit tests in one job, the e2e suite against Postgres and RabbitMQ service
containers in another, and builds both Docker images in a third.

## Configuration

All settings are environment variables, validated at startup with class-validator; the process exits with
a clear message if one is missing or invalid. See [`.env.example`](.env.example).

| Variable                       | App    | Default     | Purpose                                      |
| ------------------------------ | ------ | ----------- | -------------------------------------------- |
| `DATABASE_URL`, `RABBITMQ_URL` | both   | -           | connections                                  |
| `LOG_LEVEL`                    | both   | `info`      | pino level                                   |
| `PORT`                         | both   | 3000 / 3001 | HTTP port (worker: health only)              |
| `API_KEY`                      | api    | -           | value expected in `x-api-key` (min 16 chars) |
| `OUTBOX_POLL_INTERVAL_MS`      | api    | 500         | relay polling interval                       |
| `OUTBOX_BATCH_SIZE`            | api    | 50          | rows published per relay transaction         |
| `WORKER_PREFETCH`              | worker | 10          | unacked messages per consumer                |
| `RETRY_MAX_ATTEMPTS`           | worker | 4           | deliveries before dead-lettering             |
| `RETRY_BASE_DELAY_MS`          | worker | 1000        | first retry delay, doubled each attempt      |
| `FAKE_PAYMENT_FAILURE_RATE`    | worker | 0           | chance of a transient gateway error          |
| `FAKE_PAYMENT_DECLINE_RATE`    | worker | 0           | chance of a decline                          |
| `FAKE_PAYMENT_LATENCY_MS`      | worker | 50          | simulated gateway latency                    |

## Design decisions and trade-offs

- **Transactional outbox instead of publishing after commit.** Publishing straight from the request
  handler has two failure modes: the broker is down (the order exists but no event is sent), or the
  process dies between commit and publish. With the outbox, the event is part of the order transaction
  and the relay retries until RabbitMQ confirms it. The cost is some latency (one poll interval) and
  at-least-once delivery, which the worker already handles. The relay uses `FOR UPDATE SKIP LOCKED`, so
  several API replicas can run it at once.
- **The API declares the work queue too.** If only the worker declared `orders.payment`, an event
  published before the worker ever started would be unroutable and silently dropped.
- **One TTL queue per delay instead of per-message expiration.** RabbitMQ only expires messages at the
  head of a queue, so mixing a 4s message in front of a 1s message in one queue delays the 1s one. A queue
  per delay keeps every queue FIFO by expiry. It needs no plugin, unlike the delayed-message exchange.
  Delays are part of the queue name, so changing the retry config creates new queues instead of failing
  with `PRECONDITION_FAILED` on redeclare.
- **Exhausted retries fail the order and release stock.** Leaving the order `PENDING` would hold stock
  for a customer we couldn't charge. The DLQ keeps the message, attempt count and last error for
  inspection and alerting. Replaying it is safe: the handler sees the order is no longer `PENDING`.
- **A decline is a result, not an error.** `PaymentGateway.charge` returns `declined` and only throws for
  infrastructure problems. That keeps "retry this" and "this is final" separate without inspecting error
  messages.
- **The idempotency key lives on the order row.** With one idempotent endpoint, a unique column is
  simpler than a generic idempotency table that caches responses. If more endpoints needed it, I'd move
  to a table keyed by `(client, key)` with a stored response and an expiry.
- **Keyset pagination on `(created_at, id)`.** Offset pagination gets slower with depth and skips or
  repeats rows when new orders arrive. The cursor is opaque base64url so the format can change later.
- **amqp-connection-manager over raw amqplib.** It reconnects and re-runs each channel's setup (topology,
  consumers) after a broker restart. Writing that by hand is easy to get subtly wrong.
- **The worker is a normal Nest app with an HTTP server.** The server only serves health probes. That
  gives Docker and Kubernetes something to probe and keeps DI, config and shutdown hooks identical to
  the API.
- **Graceful shutdown.** On `SIGTERM` the worker cancels its consumer, waits for in-flight messages to
  finish (including any retry publishes), closes the channel, and only then closes the AMQP connection
  and the Prisma pool. Unacked prefetched messages go back to the queue. The API stops the relay the same
  way.
- **Known limitation: crash loops.** The attempt counter only increases when the worker catches an error.
  A message that crashes the whole process would be redelivered forever. Quorum queues with a
  `delivery-limit` would cap that; I kept classic queues to keep the setup small.

## What I'd add next

- Quorum queues with a delivery limit, and a small CLI to inspect and replay the DLQ.
- Metrics (queue depth, retry and DLQ rates, payment latency) and OpenTelemetry tracing. The API request
  id already travels to the worker in an `x-correlation-id` header and shows up in its logs.
- `LISTEN/NOTIFY` to wake the relay right after a commit instead of polling, plus a job that deletes
  published outbox rows and old idempotency keys.
- A reservation timeout that fails orders stuck in `PENDING`.
- `order.paid` and `order.failed` events for downstream services such as notifications and fulfilment.
- A real payment provider adapter behind `PaymentGateway`, and OpenAPI docs via `@nestjs/swagger`.
- Per-client API keys, with idempotency keys scoped per client.

## License

[MIT](LICENSE) © Haresh Narola
