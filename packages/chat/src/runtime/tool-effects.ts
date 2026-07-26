// packages/chat/src/runtime/tool-effects.ts
import type { CapabilityContract } from '@plumbus/core';

/**
 * A capability tool runs in 'confirm' mode when it has ANY write/side-effect:
 * data, events, external, flows, or capabilities effects non-empty. A capability
 * whose ONLY effect is `ai: true` (all effect arrays empty) is an 'auto'/read tool
 * and executes without confirmation.
 */
export function isConfirmCapability(cap: CapabilityContract): boolean {
  const e = cap.effects;
  return (
    e.data.length > 0 ||
    e.events.length > 0 ||
    e.external.length > 0 ||
    (e.flows?.length ?? 0) > 0 ||
    (e.capabilities?.length ?? 0) > 0
  );
}
