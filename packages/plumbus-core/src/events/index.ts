// ── Event Registry ──
export { EventRegistry } from "./registry.js";

// ── Event Emitter ──
export { createEventEmitter } from "./emitter.js";
export type { EventEmitterConfig } from "./emitter.js";

// ── Consumer Registry ──
export { ConsumerRegistry } from "./consumer-registry.js";
export type { EventConsumer, EventConsumerHandler } from "./consumer-registry.js";

// ── Outbox Tables ──
export { deadLetterTable, idempotencyTable, outboxTable } from "./outbox.js";

// ── Idempotency ──
export { createIdempotencyService } from "./idempotency.js";
export type { IdempotencyService } from "./idempotency.js";

// ── Queue ──
export { createInMemoryQueue, createRedisQueue } from "./queue.js";
export type { EventQueue, RedisClient, RedisQueueConfig } from "./queue.js";

// ── Dispatcher ──
export { createOutboxDispatcher } from "./dispatcher.js";
export type { DispatcherConfig } from "./dispatcher.js";

// ── Worker ──
export { createEventWorker } from "./worker.js";
export type { WorkerConfig } from "./worker.js";

