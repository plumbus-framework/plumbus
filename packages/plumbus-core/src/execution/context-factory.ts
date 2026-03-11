import { createErrorService } from "../errors/index.js";
import type { AuditService } from "../types/audit.js";
import type {
    AIService,
    ConfigService,
    DataService,
    EventService,
    ExecutionContext,
    FlowService,
    LoggerService,
    SecurityService,
    TimeService,
} from "../types/context.js";
import type { AuthContext } from "../types/security.js";

export interface ContextDependencies {
  auth: AuthContext;
  data: DataService;
  events?: EventService;
  flows?: FlowService;
  ai?: AIService;
  audit?: AuditService;
  logger?: LoggerService;
  time?: TimeService;
  config?: ConfigService;
}

const noopAudit: AuditService = {
  async record() {},
};

const noopEvents: EventService = {
  async emit() {},
};

const noopFlows: FlowService = {
  async start() {
    return { id: "", flowName: "", status: "not_started" };
  },
  async resume() {},
  async cancel() {},
  async status() {
    return { id: "", flowName: "", status: "unknown" };
  },
};

const noopAI: AIService = {
  async generate() {
    throw new Error("AI service not configured");
  },
  async extract() {
    throw new Error("AI service not configured");
  },
  async classify() {
    throw new Error("AI service not configured");
  },
  async retrieve() {
    throw new Error("AI service not configured");
  },
};

const consoleLogger: LoggerService = {
  info(message, metadata) {
    console.info(message, metadata ?? "");
  },
  warn(message, metadata) {
    console.warn(message, metadata ?? "");
  },
  error(message, metadata) {
    console.error(message, metadata ?? "");
  },
};

const realTime: TimeService = {
  now() {
    return new Date();
  },
};

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
        throw Object.assign(new Error(`Forbidden: requires role "${role}"`), { code: "forbidden" });
      }
    },
    requireScope(scope: string): void {
      if (!auth.scopes.includes(scope)) {
        throw Object.assign(new Error(`Forbidden: requires scope "${scope}"`), { code: "forbidden" });
      }
    },
  };
}

/**
 * Build an ExecutionContext from the provided dependencies.
 * Missing optional services are replaced with safe defaults/stubs.
 */
export function createExecutionContext(
  deps: ContextDependencies,
): ExecutionContext {
  return {
    auth: deps.auth,
    data: deps.data,
    events: deps.events ?? noopEvents,
    flows: deps.flows ?? noopFlows,
    ai: deps.ai ?? noopAI,
    audit: deps.audit ?? noopAudit,
    errors: createErrorService(),
    logger: deps.logger ?? consoleLogger,
    time: deps.time ?? realTime,
    config: deps.config ?? {},
    security: createSecurityService(deps.auth),
  };
}
