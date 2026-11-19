// ── Capability transaction defaults ──
// Leaf module (no imports) shared by the config loader and the executor.

/** When a capability opens its transaction when nothing says otherwise. */
export const DEFAULT_TRANSACTION_BEGIN = 'lazy' as const;

/** Longest wait for a pool connection when a capability opens its transaction (10 s). */
export const DEFAULT_TRANSACTION_ACQUIRE_TIMEOUT_MS = 10_000;
