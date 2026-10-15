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
export { bootLogger, runAppBoot } from './app-boot.js';
export type { AppBootContext, OnBootHook } from './app-boot.js';
export {
  createShutdownBudget,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  resolveShutdownSettings,
  runGracefulShutdown,
  settleBy,
  sleepUntil,
} from './graceful-shutdown.js';
export type {
  GracefulShutdownPlan,
  GracefulShutdownResult,
  OnShutdownHook,
  ShutdownBudget,
  ShutdownContext,
  ShutdownSettings,
} from './graceful-shutdown.js';
export type { RegisterCapabilityConsumersOptions } from './register-consumers.js';
