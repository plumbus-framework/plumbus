/**
 * Browser-safe error surface for `@plumbus/core/errors`.
 *
 * Client packages (for example `@plumbus/voice-livekit/client`) MUST import
 * `PlumbusError` / `ErrorCode` from this subpath, not from `@plumbus/core`.
 * The package root re-exports the CLI (drizzle-kit, esbuild, migrate) and
 * Turbopack refuses to resolve that graph for browser bundles — same pattern
 * as `@plumbus/chat/protocol`.
 */

export { errorToHttpResponse, errorToHttpStatus } from './errors/http.js';
export {
  AIBudgetExceededError,
  AISecurityBlockedError,
  BudgetExhaustedError,
  createErrorService,
  DataForbiddenError,
  DataInternalError,
  DataValidationError,
  EncryptionConfigError,
  EncryptionPayloadError,
  FlowCancelledError,
  isPlumbusError,
  LeaseLostError,
  PlumbusError,
  UnauthorizedError,
} from './errors/index.js';
export { ErrorCode } from './types/enums.js';
export type { ErrorService, PlumbusErrorLike } from './types/errors.js';
