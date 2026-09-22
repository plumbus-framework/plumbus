// ── Decision Registry ──
// Auto-discover and register decision definitions, index by name/domain

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DecisionDefinition } from '../types/decision.js';

export class DecisionRegistry {
  private decisions = new Map<string, DecisionDefinition>();

  register(decision: DecisionDefinition): void {
    if (this.decisions.has(decision.name)) {
      throw new Error(`Decision "${decision.name}" is already registered`);
    }
    this.decisions.set(decision.name, decision);
  }

  get(name: string): DecisionDefinition {
    const decision = this.decisions.get(name);
    if (!decision) {
      throw new Error(`Decision "${name}" not found in registry`);
    }
    return decision;
  }

  has(name: string): boolean {
    return this.decisions.has(name);
  }

  getAll(): DecisionDefinition[] {
    return [...this.decisions.values()];
  }

  getByDomain(domain: string): DecisionDefinition[] {
    return [...this.decisions.values()].filter((d) => d.domain === domain);
  }

  /**
   * Scan a directory for decision definition files and register them.
   * Looks for `.ts` and `.js` files, dynamically imports them, and registers
   * any exported DecisionDefinition (via default or named exports).
   */
  async discoverDecisions(dir: string): Promise<string[]> {
    const discovered: string[] = [];
    if (!fs.existsSync(dir)) return discovered;

    const files = fs
      .readdirSync(dir)
      .filter(
        (f) =>
          (f.endsWith('.ts') || f.endsWith('.js')) &&
          !f.endsWith('.d.ts') &&
          !f.endsWith('.test.ts') &&
          !f.endsWith('.test.js'),
      );

    for (const file of files) {
      const filePath = path.join(dir, file);
      const fileUrl = pathToFileURL(filePath).href;
      const mod = (await import(fileUrl)) as Record<string, unknown>;

      for (const exported of Object.values(mod)) {
        if (isDecisionDefinition(exported)) {
          if (!this.has(exported.name)) {
            this.register(exported);
            discovered.push(exported.name);
          }
        }
      }
    }
    return discovered;
  }
}

function isDecisionDefinition(value: unknown): value is DecisionDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'questions' in value &&
    typeof (value as { name: unknown }).name === 'string' &&
    typeof (value as { questions: unknown }).questions === 'object'
  );
}
