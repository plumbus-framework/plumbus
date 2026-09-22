import type { CapabilityContract } from '../types/capability.js';

/** True when the capability is exposed as an external API operation (`exposeAs: ['api']`). */
export function isApiExposed(cap: CapabilityContract): boolean {
  return cap.exposeAs?.includes('api') ?? false;
}
