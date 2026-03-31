import type { ErrorCode } from './enums.js';

// ── Structured Error Shape (duck-type for backward compat) ──
export interface PlumbusErrorLike {
  code: ErrorCode;
  message: string;
  metadata?: Record<string, unknown>;
}

// ── Error Factory ──
// Returns PlumbusErrorLike to avoid circular import with the PlumbusError class.
// At runtime, the factory returns PlumbusError class instances which satisfy this shape.
export interface ErrorService {
  validation(message: string, metadata?: Record<string, unknown>): PlumbusErrorLike;
  notFound(message: string, metadata?: Record<string, unknown>): PlumbusErrorLike;
  forbidden(message: string, metadata?: Record<string, unknown>): PlumbusErrorLike;
  conflict(message: string, metadata?: Record<string, unknown>): PlumbusErrorLike;
  internal(message: string, metadata?: Record<string, unknown>): PlumbusErrorLike;
}
