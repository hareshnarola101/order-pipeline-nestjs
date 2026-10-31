import { execSync } from 'node:child_process';
import { applyTestEnv } from './support/test-env';

/** Applies migrations to the test database once before the e2e suites run. */
export default function globalSetup(): void {
  applyTestEnv();
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: process.env });
}
