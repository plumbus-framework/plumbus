import type { ApprovalService } from '../approvals/types.js';
import type { CredentialCatalog } from '../credentials/catalog.js';
import type { EventConsumer } from '../events/consumer-registry.js';
import { CapabilityRegistry } from '../execution/capability-registry.js';
import { executeCapability, type CapabilityResult } from '../execution/capability-executor.js';
import { createExecutionContext } from '../execution/context-factory.js';
import type { ContextDependencies, ExecutionContext, FlowExecution } from '../types/context.js';
import type { AuthContext } from '../types/security.js';
import type { GovernedArtifactStore } from './governed-artifacts.js';
import type { GovernedAiHost } from './governed-host.js';
import {
  invokeGovernedAi,
  type GovernedInvokeDeps,
  type GovernedInvokeInput,
  type GovernedInvokeSuccess,
} from './governed-invoke.js';

export interface PlumbusRuntimeFlows {
  start(
    flowName: string,
    input: unknown,
    auth: AuthContext,
    opts?: { executionId?: string; correlationId?: string; triggerEventId?: string },
  ): Promise<FlowExecution>;
  status(executionId: string): Promise<FlowExecution>;
  resume?(executionId: string, signal?: unknown): Promise<void>;
  cancel?(executionId: string): Promise<void>;
}

/** Existing `EventService` (outbox emitter). Not a second bus. */
export interface PlumbusRuntimeEvents {
  emit(eventName: string, payload: unknown): Promise<void>;
  emitMany?(events: Array<{ eventName: string; payload: unknown }>): Promise<void>;
}

/** Existing outbox dispatcher (`poll` / `start` / `stop`). */
export interface PlumbusRuntimeEventPump {
  poll(): Promise<number>;
  start(): void;
  stop(): void;
}

/** Existing `ConsumerRegistry.register`. */
export interface PlumbusRuntimeSubscriptions {
  register(consumer: EventConsumer): void;
}

/** Existing flow scheduler (`syncSchedules` / `poll` / `start` / `stop`). */
export interface PlumbusRuntimeTimers {
  syncSchedules(): Promise<number>;
  poll(): Promise<number>;
  start(): void;
  stop(): void;
}

export interface PlumbusRuntimeCallOptions {
  auth?: AuthContext;
}

export type PlumbusRuntimeContextDeps =
  | Omit<ContextDependencies, 'auth'>
  | ((auth: AuthContext) => ContextDependencies);

export interface PlumbusRuntimeConfig {
  host?: GovernedAiHost;
  approvals?: ApprovalService;
  artifacts?: GovernedArtifactStore;
  credentials?: CredentialCatalog;
  now?: () => Date;
  tenantId?: string;
  recordSpend?: GovernedInvokeDeps['recordSpend'];
  /** Default actor when a call does not pass `auth`. */
  auth?: AuthContext;
  capabilities?: CapabilityRegistry;
  /**
   * Host data/events/AI attachments. The facade mints `ctx` internally —
   * application code does not call `createExecutionContext`.
   */
  contextDeps?: PlumbusRuntimeContextDeps;
  flows?: PlumbusRuntimeFlows;
  events?: PlumbusRuntimeEvents;
  eventPump?: PlumbusRuntimeEventPump;
  subscriptions?: PlumbusRuntimeSubscriptions;
  timers?: PlumbusRuntimeTimers;
}

/**
 * Host-facing runtime. Wire registries, the flow engine, events, timers, and
 * governed AI once; callers use the facade without reassembling those pieces.
 */
export interface PlumbusRuntime {
  artifacts?: GovernedArtifactStore;
  approvals?: ApprovalService;
  credentials?: CredentialCatalog;
  invokeGovernedAi(input: GovernedInvokeInput): Promise<GovernedInvokeSuccess>;
  invokeCapability(
    name: string,
    input: unknown,
    opts?: PlumbusRuntimeCallOptions,
  ): Promise<CapabilityResult>;
  startFlow(
    name: string,
    input: unknown,
    opts?: PlumbusRuntimeCallOptions & { executionId?: string },
  ): Promise<FlowExecution>;
  inspectExecution(executionId: string): Promise<FlowExecution>;
  resumeFlow(executionId: string, signal?: unknown): Promise<void>;
  cancelFlow(executionId: string): Promise<void>;
  publishEvent(eventName: string, payload: unknown): Promise<void>;
  publishEvents(events: Array<{ eventName: string; payload: unknown }>): Promise<void>;
  subscribe(consumer: EventConsumer): void;
  pumpEvents(): Promise<number>;
  startEventPump(): void;
  stopEventPump(): void;
  syncTimers(): Promise<number>;
  pollTimers(): Promise<number>;
  startTimers(): void;
  stopTimers(): void;
}

function requireAuth(config: PlumbusRuntimeConfig, override?: AuthContext): AuthContext {
  const auth = override ?? config.auth;
  if (!auth) {
    throw new Error('PlumbusRuntime requires auth on the call or at construction');
  }
  return auth;
}

function buildContext(config: PlumbusRuntimeConfig, auth: AuthContext): ExecutionContext {
  if (typeof config.contextDeps === 'function') {
    const deps = config.contextDeps(auth);
    return createExecutionContext({
      ...deps,
      auth: deps.auth ?? auth,
      approvals: deps.approvals ?? config.approvals,
    });
  }
  return createExecutionContext({
    data: {},
    ...config.contextDeps,
    auth,
    approvals: config.contextDeps?.approvals ?? config.approvals,
  });
}

function requireFlows(config: PlumbusRuntimeConfig): PlumbusRuntimeFlows {
  if (!config.flows) {
    throw new Error('PlumbusRuntime was not configured with a flow engine');
  }
  return config.flows;
}

function requireEvents(config: PlumbusRuntimeConfig): PlumbusRuntimeEvents {
  if (!config.events) {
    throw new Error('PlumbusRuntime was not configured with an event emitter');
  }
  return config.events;
}

function requireEventPump(config: PlumbusRuntimeConfig): PlumbusRuntimeEventPump {
  if (!config.eventPump) {
    throw new Error('PlumbusRuntime was not configured with an event pump');
  }
  return config.eventPump;
}

function requireSubscriptions(config: PlumbusRuntimeConfig): PlumbusRuntimeSubscriptions {
  if (!config.subscriptions) {
    throw new Error('PlumbusRuntime was not configured with a consumer registry');
  }
  return config.subscriptions;
}

function requireTimers(config: PlumbusRuntimeConfig): PlumbusRuntimeTimers {
  if (!config.timers) {
    throw new Error('PlumbusRuntime was not configured with a scheduler');
  }
  return config.timers;
}

export function createPlumbusRuntime(config: PlumbusRuntimeConfig): PlumbusRuntime {
  const capabilities = config.capabilities ?? new CapabilityRegistry();

  return {
    artifacts: config.artifacts,
    approvals: config.approvals,
    credentials: config.credentials,
    async invokeGovernedAi(input) {
      if (!config.host || !config.approvals || !config.artifacts) {
        throw new Error(
          'PlumbusRuntime was not configured with host, approvals, and artifacts for governed AI',
        );
      }
      return invokeGovernedAi(
        {
          host: config.host,
          approvals: config.approvals,
          artifacts: config.artifacts,
          now: config.now,
          tenantId: config.tenantId,
          recordSpend: config.recordSpend,
        },
        input,
      );
    },
    async invokeCapability(name, input, opts) {
      const auth = requireAuth(config, opts?.auth);
      const capability = capabilities.get(name);
      if (!capability) {
        const ctx = buildContext(config, auth);
        return {
          success: false,
          error: ctx.errors.notFound(`Capability "${name}" is not registered`),
        };
      }
      return executeCapability(capability, buildContext(config, auth), input);
    },
    async startFlow(name, input, opts) {
      const auth = requireAuth(config, opts?.auth);
      return requireFlows(config).start(name, input, auth, {
        executionId: opts?.executionId,
      });
    },
    async inspectExecution(executionId) {
      return requireFlows(config).status(executionId);
    },
    async resumeFlow(executionId, signal) {
      const flows = requireFlows(config);
      if (!flows.resume) {
        throw new Error('Configured flow engine does not support resume');
      }
      await flows.resume(executionId, signal);
    },
    async cancelFlow(executionId) {
      const flows = requireFlows(config);
      if (!flows.cancel) {
        throw new Error('Configured flow engine does not support cancel');
      }
      await flows.cancel(executionId);
    },
    async publishEvent(eventName, payload) {
      await requireEvents(config).emit(eventName, payload);
    },
    async publishEvents(events) {
      const service = requireEvents(config);
      if (service.emitMany) {
        await service.emitMany(events);
        return;
      }
      for (const event of events) {
        await service.emit(event.eventName, event.payload);
      }
    },
    subscribe(consumer) {
      requireSubscriptions(config).register(consumer);
    },
    async pumpEvents() {
      return requireEventPump(config).poll();
    },
    startEventPump() {
      requireEventPump(config).start();
    },
    stopEventPump() {
      requireEventPump(config).stop();
    },
    async syncTimers() {
      return requireTimers(config).syncSchedules();
    },
    async pollTimers() {
      return requireTimers(config).poll();
    },
    startTimers() {
      requireTimers(config).start();
    },
    stopTimers() {
      requireTimers(config).stop();
    },
  };
}
