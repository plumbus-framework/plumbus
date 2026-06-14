import type { CapabilityContract } from '../types/capability.js';
import { getCanonicalCapabilityName } from './canonical-name.js';

/**
 * Registry that holds all discovered/registered capabilities,
 * indexed by canonical name (`<domain>.<capabilityName>`) for lookup during execution.
 */
export class CapabilityRegistry {
  private capabilities = new Map<string, CapabilityContract>();

  /**
   * Register a capability contract. Throws on duplicate canonical names.
   */
  register(capability: CapabilityContract): void {
    const canonical = getCanonicalCapabilityName(capability);
    if (this.capabilities.has(canonical)) {
      throw new Error(`Capability "${canonical}" is already registered`);
    }
    this.capabilities.set(canonical, capability);
  }

  /**
   * Register multiple capabilities at once.
   */
  registerAll(capabilities: CapabilityContract[]): void {
    for (const cap of capabilities) {
      this.register(cap);
    }
  }

  /**
   * Get a capability by canonical name.
   */
  get(name: string): CapabilityContract | undefined {
    return this.capabilities.get(name);
  }

  /**
   * Return all registered capabilities.
   */
  getAll(): CapabilityContract[] {
    return Array.from(this.capabilities.values());
  }

  /**
   * Return all capabilities for a specific domain.
   */
  getByDomain(domain: string): CapabilityContract[] {
    return this.getAll().filter((c) => c.domain === domain);
  }

  /**
   * Check if a capability is registered by canonical name.
   */
  has(name: string): boolean {
    return this.capabilities.has(name);
  }

  /** Canonical names of all registered capabilities. */
  getCanonicalNames(): string[] {
    return Array.from(this.capabilities.keys());
  }
}
