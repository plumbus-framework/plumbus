// packages/chat/src/runtime/tool-effects.ts
import type { CapabilityContract } from '@plumbus/core';

/**
 * A capability tool runs in 'confirm' mode when it has ANY write/side-effect:
 * data, events, external, flows, or capabilities effects non-empty. A capability
 * whose ONLY effect is `ai: true` (all effect arrays empty) is an 'auto'/read tool
 * and executes without confirmation. With `readOnlyQueries`, a query whose
 * only other effect is `data` is auto as well.
 */
export function isConfirmCapability(
  cap: CapabilityContract,
  opts?: {
    /**
     * `policy.toolCalling.readOnlyQueries`: a `kind: 'query'` capability whose
     * only effects are `data` reads (and `ai`) is auto, not confirm.
     */
    readOnlyQueries?: boolean;
  },
): boolean {
  const e = cap.effects;
  const dataIsReadOnly = opts?.readOnlyQueries === true && cap.kind === 'query';
  return (
    (e.data.length > 0 && !dataIsReadOnly) ||
    e.events.length > 0 ||
    e.external.length > 0 ||
    (e.flows?.length ?? 0) > 0 ||
    (e.capabilities?.length ?? 0) > 0
  );
}
