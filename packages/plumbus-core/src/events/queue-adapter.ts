// ── Queue Adapter Interface ──
// Pluggable factory for durable queue backends (Redis v1; SQS/Kafka later).

import type { PlumbusConfig } from '../types/config.js';
import type { RuntimeQueues } from '../runtime/queue-factory.js';

/** Factory that creates runtime queue triplets for a deployment environment. */
export interface QueueAdapterFactory {
  createQueues(config: PlumbusConfig): Promise<RuntimeQueues>;
}
