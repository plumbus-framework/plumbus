import type { EventDefinition } from "../types/event.js";

/**
 * Registry that holds all discovered/registered event definitions,
 * indexed by name (and optionally version) for schema validation
 * during emission and consumer routing.
 */
export class EventRegistry {
  private events = new Map<string, EventDefinition>();

  /**
   * Register an event definition. Throws on duplicate names.
   * Stores under both the plain name and the versioned key (name@version).
   */
  register(event: EventDefinition): void {
    const key = this.key(event.name, event.version);
    if (this.events.has(key)) {
      throw new Error(`Event "${key}" is already registered`);
    }
    this.events.set(key, event);
    // Also store under the plain name for version-agnostic lookups
    if (event.version && !this.events.has(event.name)) {
      this.events.set(event.name, event);
    }
  }

  /**
   * Register multiple event definitions at once.
   */
  registerAll(events: EventDefinition[]): void {
    for (const event of events) {
      this.register(event);
    }
  }

  /**
   * Get an event definition by name (and optional version).
   */
  get(name: string, version?: string): EventDefinition | undefined {
    return this.events.get(this.key(name, version));
  }

  /**
   * Check if an event is registered.
   */
  has(name: string, version?: string): boolean {
    return this.events.has(this.key(name, version));
  }

  /**
   * Return all registered event definitions.
   */
  getAll(): EventDefinition[] {
    return Array.from(this.events.values());
  }

  /**
   * Return all events for a specific domain.
   */
  getByDomain(domain: string): EventDefinition[] {
    return this.getAll().filter((e) => e.domain === domain);
  }

  private key(name: string, version?: string): string {
    return version ? `${name}@${version}` : name;
  }
}
