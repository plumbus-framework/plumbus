import type { ErrorCode } from "./enums.js";

// ── Structured Error ──
export interface PlumbusError {
  code: ErrorCode;
  message: string;
  metadata?: Record<string, unknown>;
}

// ── Error Factory ──
export interface ErrorService {
  validation(message: string, metadata?: Record<string, unknown>): PlumbusError;
  notFound(message: string, metadata?: Record<string, unknown>): PlumbusError;
  forbidden(message: string, metadata?: Record<string, unknown>): PlumbusError;
  conflict(message: string, metadata?: Record<string, unknown>): PlumbusError;
  internal(message: string, metadata?: Record<string, unknown>): PlumbusError;
}
