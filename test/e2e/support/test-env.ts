/**
 * Defaults match `docker compose up -d postgres rabbitmq` (see the host ports in
 * docker-compose.yml). CI sets DATABASE_URL and RABBITMQ_URL explicitly.
 * Anything already set in the environment wins.
 */
export function applyTestEnv(): void {
  const defaults: Record<string, string> = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://orders:orders@localhost:5433/orders_test',
    RABBITMQ_URL: 'amqp://guest:guest@localhost:5673',
    API_KEY: 'e2e-test-api-key-0123456789',
    LOG_LEVEL: 'silent',
    OUTBOX_POLL_INTERVAL_MS: '100',
    RETRY_MAX_ATTEMPTS: '3',
    RETRY_BASE_DELAY_MS: '200',
    FAKE_PAYMENT_LATENCY_MS: '0',
    FAKE_PAYMENT_FAILURE_RATE: '0',
    FAKE_PAYMENT_DECLINE_RATE: '0',
  };
  for (const [key, value] of Object.entries(defaults)) {
    process.env[key] ??= value;
  }
}
