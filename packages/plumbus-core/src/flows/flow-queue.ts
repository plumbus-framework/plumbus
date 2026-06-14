import type { EventQueue } from '../events/queue.js';
import type { EventEnvelope } from '../types/event.js';

export const FLOW_STEP_EVENT_PREFIX = 'flow.step.';

export function flowStepEventType(executionId: string): string {
  return `${FLOW_STEP_EVENT_PREFIX}${executionId}`;
}

export interface FlowStepQueuePayload {
  executionId: string;
}

/** Enqueue a flow step execution wake-up on the flows queue. */
export async function enqueueFlowStep(
  queue: EventQueue,
  executionId: string,
  correlationId?: string,
): Promise<void> {
  const envelope: EventEnvelope<FlowStepQueuePayload> = {
    id: crypto.randomUUID(),
    eventType: flowStepEventType(executionId),
    version: '1',
    occurredAt: new Date(),
    actor: 'system-flow-runner',
    correlationId: correlationId ?? executionId,
    payload: { executionId },
  };
  await queue.publish(envelope);
}

export function parseFlowStepExecutionId(eventType: string): string | undefined {
  if (!eventType.startsWith(FLOW_STEP_EVENT_PREFIX)) {
    return undefined;
  }
  const id = eventType.slice(FLOW_STEP_EVENT_PREFIX.length);
  return id.length > 0 ? id : undefined;
}
