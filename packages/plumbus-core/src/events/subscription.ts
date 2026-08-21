import type { EventEnvelope } from '../types/event.js';
import type { EventConsumer } from './consumer-registry.js';

/**
 * v1 subscription binding (trigger-definition EventSubscriptionDefinition subset).
 * Pins delivery to a consumer capability version. No second bus — the existing
 * worker applies this at deliver time.
 */
export interface EventSubscriptionBinding {
  subscriptionId: string;
  eventType: string;
  consumerCapabilityId: string;
  consumerCapabilityVersion: string;
  active: boolean;
}

export type EventSubscriptionSkipReason = 'inactive' | 'policy-denied';

export interface EventSubscriptionDecision {
  deliver: boolean;
  reason?: EventSubscriptionSkipReason;
}

/**
 * Activation + policy gate used by `createEventWorker` before the handler.
 * Version matching stays on `ConsumerRegistry.getConsumers`.
 */
export function evaluateEventSubscriptionDelivery(input: {
  active?: boolean;
  policyAllowed?: boolean;
}): EventSubscriptionDecision {
  if (input.active === false) {
    return { deliver: false, reason: 'inactive' };
  }
  if (input.policyAllowed === false) {
    return { deliver: false, reason: 'policy-denied' };
  }
  return { deliver: true };
}

export async function resolveConsumerDeliveryPolicy(
  consumer: EventConsumer,
  envelope: EventEnvelope,
): Promise<boolean> {
  if (!consumer.checkDeliveryPolicy) return true;
  return consumer.checkDeliveryPolicy(envelope);
}
