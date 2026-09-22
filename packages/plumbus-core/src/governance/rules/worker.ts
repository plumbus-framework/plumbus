// ── Worker / queue governance rules ──

import { z } from 'zod';
import { CapabilityKind, GovernanceSeverity } from '../../types/enums.js';
import type { GovernanceRule } from '../rule-engine.js';

function zodObjectKeys(schema: z.ZodTypeAny): Set<string> | null {
  if (schema instanceof z.ZodObject) {
    return new Set(Object.keys(schema.shape));
  }
  return null;
}

/** Warn when eventHandler capabilities lack trigger.event (no auto-registration). */
export const ruleEventHandlerMissingTrigger: GovernanceRule = {
  id: 'worker.event-handler-missing-trigger',
  category: 'architecture',
  severity: GovernanceSeverity.Warning,
  description: 'eventHandler capabilities should declare trigger.event for auto-registration',
  evaluate(inventory) {
    return inventory.capabilities
      .filter((cap) => cap.kind === CapabilityKind.EventHandler && !cap.trigger?.event)
      .map((cap) => ({
        severity: GovernanceSeverity.Warning,
        rule: 'worker.event-handler-missing-trigger',
        description: `eventHandler "${cap.name}" has no trigger.event — it will not auto-register`,
        affectedComponent: `capability:${cap.name}`,
        remediation:
          'Add `trigger: { event: "your.event" }` or register a ConsumerRegistry handler in app/server.ts',
      }));
  },
};

/** Warn eventHandlers with data/event side effects about at-least-once delivery idempotency. */
export const ruleEventHandlerSideEffects: GovernanceRule = {
  id: 'worker.event-handler-side-effects',
  category: 'architecture',
  severity: GovernanceSeverity.Info,
  description:
    'eventHandler capabilities with write effects should be idempotent (at-least-once delivery)',
  evaluate(inventory) {
    return inventory.capabilities
      .filter(
        (cap) =>
          cap.kind === CapabilityKind.EventHandler &&
          ((cap.effects?.data?.length ?? 0) > 0 || (cap.effects?.events?.length ?? 0) > 0),
      )
      .map((cap) => ({
        severity: GovernanceSeverity.Info,
        rule: 'worker.event-handler-side-effects',
        description: `eventHandler "${cap.name}" mutates data/events — ensure handler logic is idempotent`,
        affectedComponent: `capability:${cap.name}`,
        remediation:
          'Design handlers to tolerate duplicate delivery (natural keys, upserts, or idempotency checks)',
      }));
  },
};

/** Advisory: handler input schema should be compatible with event payload schema. */
export const ruleEventHandlerPayloadCompatibility: GovernanceRule = {
  id: 'worker.event-handler-payload-compatibility',
  category: 'architecture',
  severity: GovernanceSeverity.Warning,
  description: 'eventHandler input schema should align with the triggered event payload schema',
  evaluate(inventory) {
    const eventByName = new Map(inventory.events.map((evt) => [evt.name, evt]));
    const signals = [];

    for (const cap of inventory.capabilities) {
      if (cap.kind !== CapabilityKind.EventHandler || !cap.trigger?.event) {
        continue;
      }
      const eventDef = eventByName.get(cap.trigger.event);
      if (!eventDef) {
        continue;
      }
      const handlerKeys = zodObjectKeys(cap.input);
      const eventKeys = zodObjectKeys(eventDef.payload);
      if (!handlerKeys || !eventKeys) {
        continue;
      }
      const missingOnEvent = [...handlerKeys].filter((key) => !eventKeys.has(key));
      if (missingOnEvent.length === 0) {
        continue;
      }
      signals.push({
        severity: GovernanceSeverity.Warning,
        rule: 'worker.event-handler-payload-compatibility',
        description: `eventHandler "${cap.name}" expects input keys [${missingOnEvent.join(', ')}] not present on event "${cap.trigger.event}" payload`,
        affectedComponent: `capability:${cap.name}`,
        remediation:
          'Align handler input with the event payload schema, or narrow handler input to a subset of event fields',
      });
    }

    return signals;
  },
};

export const workerRules = [
  ruleEventHandlerMissingTrigger,
  ruleEventHandlerSideEffects,
  ruleEventHandlerPayloadCompatibility,
];
