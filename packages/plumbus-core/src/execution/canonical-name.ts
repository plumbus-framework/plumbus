/** Minimal shape for deriving a registered capability name. */
export interface CanonicalCapabilityRef {
  domain: string;
  name: string;
}

/**
 * Canonical registered capability name: `<domain>.<capabilityName>`.
 * Used for registry lookup, effects.capabilities, flow steps, invoke, manifests, and audit.
 */
export function getCanonicalCapabilityName(ref: CanonicalCapabilityRef): string {
  return `${ref.domain}.${ref.name}`;
}

/** True when `value` looks like a canonical capability name (contains a domain prefix). */
export function isCanonicalCapabilityName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.includes('.')) {
    return false;
  }
  const dot = trimmed.indexOf('.');
  return dot > 0 && dot < trimmed.length - 1;
}
