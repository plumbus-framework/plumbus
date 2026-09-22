// ── Runtime Module ──
// Shared bootstrap, queue resolution, and consumer registration for CLI entry points.

export {
  RuntimeRole,
  buildStepDeps,
  buildWorkerAiService,
  discoverRuntimeResources,
  needsJobQueuePublish,
  needsWorkerPool,
  resolveRuntimeRole,
  shouldStartApiServer,
  shouldStartWorkerPool,
} from './bootstrap.js';
export type {
  BuildWorkerAiServiceOptions,
  RuntimeCommand,
  ServerExtensions,
} from './bootstrap.js';
export {
  QueueBackend,
  resolveRuntimeQueues,
  shouldUseRedisBackend,
  tryCreateRedisClient,
} from './queue-factory.js';
export type { ResolveRuntimeQueuesOptions, RuntimeQueues } from './queue-factory.js';
export { registerCapabilityConsumers } from './register-consumers.js';
export type { RegisterCapabilityConsumersOptions } from './register-consumers.js';
