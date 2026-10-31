import { Prisma } from '@prisma/client';

/**
 * True when the error is a unique-constraint violation. `column` narrows the check
 * to a specific column; Prisma reports either column names or the index name.
 */
export function isUniqueViolation(error: unknown, column?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  if (!column) {
    return true;
  }
  const target: unknown = error.meta?.target;
  const values = Array.isArray(target) ? target.map(String) : [String(target)];
  return values.some((value) => value.includes(column));
}
