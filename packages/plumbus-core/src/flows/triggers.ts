import type { EventEnvelope } from '../types/event.js';
import type { AuthContext } from '../types/security.js';
import type { createFlowEngine } from './engine.js';
import type { FlowRegistry } from './registry.js';

/**
 * Creates event-to-flow trigger integration.
 * When an event arrives, checks if any registered flows have a matching trigger
 * and starts new flow executions with the event payload as input.
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
  async function handleEvent(envelope: EventEnvelope): Promise<number> {
    const matchingFlows = registry.getByTriggerEvent(envelope.eventType);
    if (matchingFlows.length === 0) return 0;

    const auth: AuthContext = {
      userId: envelope.actor,
      tenantId: envelope.tenantId,
      roles: [],
      scopes: [],
      provider: 'event-trigger',
    };

    let started = 0;
    for (const flow of matchingFlows) {
      await engine.start(flow.name, envelope.payload, auth, {
        correlationId: envelope.correlationId,
        triggerEventId: envelope.id,
      });
      started++;
    }

    const resumed = await engine.resumeWaitingByEvent(envelope.eventType, envelope.payload);
    return started + resumed;
  }

  return { handleEvent };
}
