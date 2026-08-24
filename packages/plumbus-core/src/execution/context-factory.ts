import { createErrorService, PlumbusError } from '../errors/index.js';
import { ErrorCode } from '../types/enums.js';
import type { AuditService } from '../types/audit.js';
import type {
  AIService,
  ContextDependencies,
  EventService,
  ExecutionContext,
  FlowService,
  JobDispatchService,
  LoggerService,
  SecurityService,
  TimeService,
} from '../types/context.js';
import type { AuthContext } from '../types/security.js';
import type { TranslationService } from '../types/translation.js';
import { createUnavailableCapabilityService } from './capability-invocation.js';

export type { ContextDependencies } from '../types/context.js';

const noopAudit: AuditService = {
  async record() {},
};

const noopTranslations: TranslationService = {
  locale: 'en',
  t: (key) => key,
};

const noopEvents: EventService = {
  async emit() {},
  async emitMany() {},
};

const noopJobs: JobDispatchService = {
  async enqueue() {
    throw new PlumbusError(
      ErrorCode.Internal,
      'Job queue not configured on this execution context',
    );
  },
};

const noopFlows: FlowService = {
  async start() {
    return { id: '', flowName: '', status: 'not_started' };
  },
  async resume() {},
  async cancel() {},
  async status() {
    return { id: '', flowName: '', status: 'unknown' };
  },
  async heartbeat() {},
};

const noopAI: AIService = {
  async recordProviderCost() {
    throw new Error('AI service not configured');
  },
  checkProviderCostBudget() {
    throw new Error('AI service not configured');
  },
  async generate() {
    throw new Error('AI service not configured');
  },
  async generateWithUsage() {
    throw new Error('AI service not configured');
  },
  streamGenerate() {
    throw new Error('AI service not configured');
  },
  async extract() {
    throw new Error('AI service not configured');
  },
  async classify() {
    throw new Error('AI service not configured');
  },
  async retrieve() {
    throw new Error('AI service not configured');
  },
};

const consoleLogger: LoggerService = {
  debug(message, metadata) {
    console.debug(message, metadata ?? '');
  },
  info(message, metadata) {
    console.info(message, metadata ?? '');
  },
  warn(message, metadata) {
    console.warn(message, metadata ?? '');
  },
  error(message, metadata) {
    console.error(message, metadata ?? '');
  },
};

const realTime: TimeService = {
  now() {
    return new Date();
  },
};

/**
 * True for objects whose own enumerable data the authority walk may traverse:
 * plain records (`{}` / `Object.create(null)`) and arrays. Class instances,
 * functions, `Date`, `Map`, and host objects are deliberately excluded — they
 * are frozen at their own level but never walked, so the seal never reaches
 * into an object that owns behaviour or internal state.
 */
function isTraversableAuthorityValue(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively freeze the identity/authority surface of an execution context.
 *
 * Only plain data is walked (see {@link isTraversableAuthorityValue}), so role
 * and scope arrays, and any nested claim records a deployment carries on its
 * auth shape, become immutable while service objects are never touched.
 *
 * This is deliberately not `deepFreeze` from `types/deep-freeze.js`, which
 * freezes definition graphs. Three differences matter for a security boundary:
 * this walk descends only into plain records and arrays instead of every object
 * it meets; it reads through property descriptors, so a computed claim's getter
 * is never invoked just by sealing the context; and it walks `Reflect.ownKeys`
 * and does not stop at an already-frozen container, so an auth object a caller
 * shallow-froze before handing it over still has its role and scope arrays
 * sealed, and symbol-keyed claims are not skipped.
 *
 * Caveat worth stating plainly: `Object.freeze` seals own properties, not
 * internal slots. A frozen `Date` (e.g. `auth.authenticatedAt`) still honours
 * `setTime()`. Callers that need a tamper-proof timestamp should carry it as an
 * ISO string or epoch number rather than a `Date`.
 */
function freezeAuthoritySurface<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value;
  }
  const target = value as unknown as object;
  if (seen.has(target)) return value;
  seen.add(target);

  if (typeof target === 'object' && isTraversableAuthorityValue(target)) {
    for (const key of Reflect.ownKeys(target)) {
      // Read through the descriptor so getters are not invoked by the walk.
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor && 'value' in descriptor) {
        freezeAuthoritySurface(descriptor.value, seen);
      }
    }
  }

  Object.freeze(target);
  return value;
}

function createSecurityService(auth: AuthContext): SecurityService {
  return {
    hasRole(role: string): boolean {
      return auth.roles.includes(role);
    },
    hasScope(scope: string): boolean {
      return auth.scopes.includes(scope);
    },
    hasAllRoles(roles: string[]): boolean {
      return roles.every((r) => auth.roles.includes(r));
    },
    hasAllScopes(scopes: string[]): boolean {
      return scopes.every((s) => auth.scopes.includes(s));
    },
    requireRole(role: string): void {
      if (!auth.roles.includes(role)) {
        throw Object.assign(new Error(`Forbidden: requires role "${role}"`), { code: 'forbidden' });
      }
    },
    requireScope(scope: string): void {
      if (!auth.scopes.includes(scope)) {
        throw Object.assign(new Error(`Forbidden: requires scope "${scope}"`), {
          code: 'forbidden',
        });
      }
    },
  };
}

/**
 * Build an ExecutionContext from the provided dependencies.
 * Missing optional services are replaced with safe defaults.
 *
 * The returned context is sealed: the platform establishes the actor once, and
 * no in-process code can afterwards fabricate or elevate it. The seal has two
 * layers, with a deliberate boundary between them.
 *
 * **Frozen — the identity/authority surface.**
 * - the context container itself, so `ctx.auth` cannot be re-pointed at a
 *   fabricated actor and `ctx.data` / `ctx.audit` cannot be swapped for an
 *   unscoped or silenced replacement;
 * - `auth`, deeply, including its role and scope arrays. It is frozen *in
 *   place* rather than copied, so the very object the data, event, and audit
 *   services closed over for tenant scoping is the immutable one — a copy would
 *   leave those services reading an actor that could still drift from
 *   `ctx.auth`;
 * - `request`, the audit provenance of the call (source IP, user agent);
 * - `security`, whose predicates are the authority decisions themselves —
 *   without this, `ctx.security.hasRole = () => true` would be an elevation.
 *
 * **Not frozen — service objects with legitimate mutable internals.**
 * `data`, `events`, `flows`, `jobs`, `ai`, `audit`, `logger`, `time`, `config`,
 * `translations`, `capabilities`, `progress`, and `__runtime` keep their own
 * state: audit buffers, the invocation emit scope whose causation fields the
 * executor sets and restores per call, the active transaction scope, and the
 * deferred post-commit queue. Freezing those would break the pipeline while
 * adding nothing — none of them carries the actor.
 *
 * Contexts derived from this one by spreading (`{ ...ctx, step, state }` in the
 * flow engine, the capability executor, and the invocation pipeline) are fresh,
 * writable containers by design, but they carry the same frozen `auth` object
 * by reference, so the actor stays immutable everywhere it is observed.
 *
 * **Per-invocation attachments belong in `deps`.** Because the container is
 * sealed, `signal` and `progress` — the two fields a host used to attach after
 * building the context — are accepted as dependencies and set here. A host that
 * learns of them later (a timeout armed after authentication, say) builds the
 * context once it knows, or derives one by spreading; it never assigns onto a
 * finished context.
 */
export function createExecutionContext(deps: ContextDependencies): ExecutionContext {
  const auth = freezeAuthoritySurface(deps.auth);
  const baseRuntime = {
    invokeCapability: deps.invokeCapability,
    resolveCapability: deps.resolveCapability,
    correlationId: deps.correlationId,
    invocationEmitScope: deps.invocationEmitScope,
    withTransaction: deps.withTransaction,
    approvals: deps.approvals,
    authorizationProvider: deps.authorizationProvider,
    artifacts: deps.artifacts,
  };

  const ctx: ExecutionContext = {
    auth,
    data: deps.data,
    events: deps.events ?? noopEvents,
    flows: deps.flows ?? noopFlows,
    jobs: deps.jobs ?? noopJobs,
    ai: deps.ai ?? noopAI,
    audit: deps.audit ?? noopAudit,
    errors: createErrorService(),
    logger: deps.logger ?? consoleLogger,
    time: deps.time ?? realTime,
    config: deps.config ?? {},
    security: Object.freeze(createSecurityService(auth)),
    translations: deps.translations ?? noopTranslations,
    request: freezeAuthoritySurface(deps.request),
    signal: deps.signal,
    progress: deps.progress,
    capabilities: createUnavailableCapabilityService({} as ExecutionContext),
    __runtime: baseRuntime,
  };

  // Self-reference must be wired before the container is sealed.
  ctx.capabilities = createUnavailableCapabilityService(ctx);

  Object.freeze(ctx);
  return ctx;
}
