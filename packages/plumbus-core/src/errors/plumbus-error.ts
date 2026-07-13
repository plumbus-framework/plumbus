import type { ErrorCode } from '../types/enums.js';

/** Base structured error with code + metadata for framework handlers. */
export class PlumbusError extends Error {
  readonly code: ErrorCode;
  readonly metadata?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, metadata?: Record<string, unknown>) {
    super(message);
    this.name = 'PlumbusError';
    this.code = code;
    this.metadata = metadata;
  }

  toJSON(): { code: ErrorCode; message: string; metadata?: Record<string, unknown> } {
    return { code: this.code, message: this.message, metadata: this.metadata };
  }
}
