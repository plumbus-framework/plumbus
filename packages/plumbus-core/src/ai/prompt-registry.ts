// ── Prompt Registry ──
// Auto-discover and register prompt definitions, index by name/domain

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PromptDefinition } from '../types/prompt.js';

export class PromptRegistry {
  private prompts = new Map<string, PromptDefinition>();

  register(prompt: PromptDefinition): void {
    if (this.prompts.has(prompt.name)) {
      throw new Error(`Prompt "${prompt.name}" is already registered`);
    }
    this.prompts.set(prompt.name, prompt);
  }

  get(name: string): PromptDefinition {
    const prompt = this.prompts.get(name);
    if (!prompt) {
      throw new Error(`Prompt "${name}" not found in registry`);
    }
    return prompt;
  }

  has(name: string): boolean {
    return this.prompts.has(name);
  }

  getAll(): PromptDefinition[] {
    return [...this.prompts.values()];
  }

  getByDomain(domain: string): PromptDefinition[] {
    return [...this.prompts.values()].filter((p) => p.domain === domain);
  }

  /**
   * Scan a directory for prompt definition files and register them.
   * Looks for `.ts` and `.js` files, dynamically imports them,
   * and registers any exported PromptDefinition (via default or named exports).
   */
  async discoverPrompts(dir: string): Promise<string[]> {
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
        if (isPromptDefinition(exported)) {
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

function isPromptDefinition(value: unknown): value is PromptDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'input' in value &&
    'output' in value &&
    typeof (value as any).name === 'string'
  );
}
