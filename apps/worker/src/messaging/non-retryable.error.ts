/** Thrown when retrying cannot help (malformed message, missing order). Goes straight to the DLQ. */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}
