import { decodeCursor, encodeCursor } from './cursor';
import { InvalidCursorError } from './orders.errors';

describe('order cursor', () => {
  it('round-trips createdAt and id', () => {
    const cursor = { createdAt: new Date('2026-05-06T07:08:09.123Z'), id: 'abc' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each(['not-base64-json', Buffer.from('{"a":1}').toString('base64url'), ''])(
    'rejects malformed input %p',
    (raw) => {
      expect(() => decodeCursor(raw)).toThrow(InvalidCursorError);
    },
  );
});
