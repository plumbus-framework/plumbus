import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { FlowDefinition } from "../types/flow.js";

/**
 * Registry that holds all discovered/registered flow definitions,
 * indexed by name for lookup during execution and event triggering.
 */
export class FlowRegistry {
  private flows = new Map<string, FlowDefinition>();

  /**
   * Register a flow definition. Throws on duplicate names.
   */
  register(flow: FlowDefinition): void {
    if (this.flows.has(flow.name)) {
      throw new Error(`Flow "${flow.name}" is already registered`);
    }
    this.flows.set(flow.name, flow);
  }

  /**
   * Register multiple flow definitions at once.
   */
  registerAll(flows: FlowDefinition[]): void {
    for (const flow of flows) {
      this.register(flow);
    }
  }

  /**
   * Get a flow definition by name.
   */
  get(name: string): FlowDefinition | undefined {
    return this.flows.get(name);
  }

  /**
   * Check if a flow is registered.
   */
  has(name: string): boolean {
    return this.flows.has(name);
  }

  /**
   * Return all registered flow definitions.
   */
  getAll(): FlowDefinition[] {
    return Array.from(this.flows.values());
  }

  /**
   * Return all flows for a specific domain.
   */
  getByDomain(domain: string): FlowDefinition[] {
    return this.getAll().filter((f) => f.domain === domain);
  }

  /**
   * Return all flows that have an event trigger matching the given event type.
   */
  getByTriggerEvent(eventType: string): FlowDefinition[] {
    return this.getAll().filter((f) => f.trigger?.event === eventType);
  }

  /**
   * Return all flows that have a schedule configured.
   */
  getScheduled(): FlowDefinition[] {
    return this.getAll().filter((f) => f.schedule != null);
  }

  /**
   * Scan a directory for flow definition files and register them.
   * Looks for `.ts` and `.js` files, dynamically imports them,
   * and registers any exported FlowDefinition (via default or named exports).
   */
  async discoverFlows(dir: string): Promise<string[]> {
    const discovered: string[] = [];
    if (!fs.existsSync(dir)) return discovered;

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Recurse into subdirectories (e.g., app/flows/orders/approval/)
        const nested = await this.discoverFlows(fullPath);
        discovered.push(...nested);
        continue;
      }
      if (
        !(entry.name.endsWith(".ts") || entry.name.endsWith(".js")) ||
        entry.name.endsWith(".d.ts") ||
        entry.name.endsWith(".test.ts") ||
        entry.name.endsWith(".test.js")
      ) {
        continue;
      }
      const fileUrl = pathToFileURL(fullPath).href;
      const mod = await import(fileUrl) as Record<string, unknown>;

      for (const exported of Object.values(mod)) {
        if (isFlowDefinition(exported) && !this.has(exported.name)) {
          this.register(exported);
          discovered.push(exported.name);
        }
      }
    }
    return discovered;
  }
}

function isFlowDefinition(value: unknown): value is FlowDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "domain" in value &&
    "input" in value &&
    "steps" in value &&
    Array.isArray((value as any).steps)
  );
}
