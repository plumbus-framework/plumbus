import { validatedTraceparent } from '../observability/index.js';
import type { EventEnvelope } from '../types/event.js';
import type { AuthContext } from '../types/security.js';
import type { createFlowEngine } from './engine.js';
import type { FlowRegistry } from './registry.js';

/**
 * Creates event-to-flow trigger integration.
 * When an event arrives, checks if any registered flows have a matching trigger
 * and starts new flow executions with the event payload as input. Executions
 * waiting on the event type are resumed only within the event's tenant.
 */
export function createFlowTriggerHandler(config: {
  registry: FlowRegistry;
  engine: ReturnType<typeof createFlowEngine>;
}) {
  const { registry, engine } = config;

  /**
   * Process an incoming event and start any triggered flows.
   * Returns the number of flows started.
   */
  async function handleEvent(envelope: EventEnvelope): Promise<string[]> {
    const matchingFlows = registry.getByTriggerEvent(envelope.eventType);
    const executionIds: string[] = [];

    const auth: AuthContext = {
      userId: envelope.actor,
      tenantId: envelope.tenantId,
      roles: [],
      scopes: [],
      provider: 'event-trigger',
    };

    for (const flow of matchingFlows) {
      const exec = await engine.start(flow.name, envelope.payload, auth, {
        correlationId: envelope.correlationId,
        traceparent: validatedTraceparent(envelope.traceparent),
        triggerEventId: envelope.id,
      });
      executionIds.push(exec.id);
    }

    // Resume only executions in the event's own tenant. A tenantless event
    // resumes only tenantless executions, and a tenant event never resumes
    // tenantless ones or another tenant's.
    const resumedIds = await engine.resumeWaitingByEvent(envelope.eventType, envelope.payload, {
      tenantId: envelope.tenantId ?? null,
    });
    return [...executionIds, ...resumedIds];
  }

  return { handleEvent };
}
