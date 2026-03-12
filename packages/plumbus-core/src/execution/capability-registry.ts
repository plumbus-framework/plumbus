import type { CapabilityContract } from '../types/capability.js';

/**
 * Registry that holds all discovered/registered capabilities,
 * indexed by name for lookup during execution and route generation.
 */
export class CapabilityRegistry {
  private capabilities = new Map<string, CapabilityContract>();

  /**
   * Register a capability contract. Throws on duplicate names.
   */
  register(capability: CapabilityContract): void {
    if (this.capabilities.has(capability.name)) {
      throw new Error(`Capability "${capability.name}" is already registered`);
    }
    this.capabilities.set(capability.name, capability);
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
   * Get a capability by name.
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
   * Check if a capability is registered.
   */
  has(name: string): boolean {
    return this.capabilities.has(name);
  }
}
