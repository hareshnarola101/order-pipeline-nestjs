import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validateSync } from 'class-validator';

/**
 * Validates process.env against a class-validator schema at startup, so a
 * misconfigured container fails fast instead of at the first request.
 */
export function validateEnv<T extends object>(
  schema: ClassConstructor<T>,
  config: Record<string, unknown>,
): T {
  const env = plainToInstance(schema, config, { enableImplicitConversion: true });
  const errors = validateSync(env, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => `${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return env;
}
