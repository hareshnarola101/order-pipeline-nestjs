import { InvalidCursorError } from './orders.errors';

export interface OrderCursor {
  createdAt: Date;
  id: string;
}

/** Opaque keyset cursor: base64url of `[createdAt, id]` of the last row on the page. */
export function encodeCursor(cursor: OrderCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.id])).toString(
    'base64url',
  );
}

export function decodeCursor(raw: string): OrderCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2) {
      const [createdAt, id] = parsed as unknown[];
      const date = new Date(String(createdAt));
      if (typeof id === 'string' && id.length > 0 && !Number.isNaN(date.getTime())) {
        return { createdAt: date, id };
      }
    }
  } catch {
    // fall through to the error below
  }
  throw new InvalidCursorError();
}
