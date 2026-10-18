import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { EntityDefinition } from '../types/entity.js';
import type { CapabilityContract } from '../types/capability.js';
import type { DiscoveredResources } from '../cli/discover.js';
import { createErrorService } from '../errors/index.js';
import type { ServerExtensions } from './bootstrap.js';

/** Explicit resources and shared AI hooks needed by a voice worker. */
export interface VoiceRuntimeConfig {
  resources: {
    capabilities: CapabilityContract<any, any>[];
    securityEntities?: EntityDefinition[];
  } & Pick<DiscoveredResources, 'entities' | 'events' | 'prompts'> &
    Partial<Pick<DiscoveredResources, 'flows' | 'translations' | 'decisions'>>;
  extensions: Pick<
    ServerExtensions,
    'onAICostRecorded' | 'resolveAiOverrides' | 'enableStrictStructuredOutputs' | 'decisions'
  >;
}

// Resource definitions are authored with define*(); validate the module envelope
// here, then register the original definitions with the normal registries.
const runtimeSchema = z
  .object({
    resources: z
      .object({
        capabilities: z.array(z.unknown()),
        entities: z.array(z.unknown()),
        securityEntities: z.array(z.unknown()).optional(),
        events: z.array(z.unknown()),
        prompts: z.array(z.unknown()),
        flows: z.array(z.unknown()).optional(),
        translations: z.array(z.unknown()).optional(),
        decisions: z.array(z.unknown()).optional(),
      })
      .strict(),
    extensions: z
      .object({
        onAICostRecorded: z.function().optional(),
        resolveAiOverrides: z.function().optional(),
        enableStrictStructuredOutputs: z.boolean().optional(),
        decisions: z.object({}).passthrough().optional(),
      })
      .strict(),
  })
  .strict();

/** Missing module keeps legacy discovery; a broken module fails startup. */
export async function loadVoiceRuntime(
  appRoot = process.cwd(),
  options: { javascriptOnly?: boolean } = {},
): Promise<VoiceRuntimeConfig | null> {
  const file = (options.javascriptOnly ? ['runtime.js'] : ['runtime.ts', 'runtime.js'])
    .map((name) => path.join(appRoot, 'app', 'voice', name))
    .find((candidate) => fs.existsSync(candidate));
  if (!file) {
    if (options.javascriptOnly)
      throw createErrorService().validation('Compiled voice app requires app/voice/runtime.js');
    return null;
  }

  let unregister: (() => void) | undefined;
  try {
    if (file.endsWith('.ts')) {
      const require = createRequire(import.meta.url);
      const tsx = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
      unregister = tsx.register();
    }
    const mod = await import(pathToFileURL(file).href);
    const parsed = runtimeSchema.safeParse(mod.voiceRuntime);
    if (!parsed.success) {
      throw createErrorService().validation(
        `${file} must export voiceRuntime with resources and explicit extensions`,
        { issues: parsed.error.issues },
      );
    }
    // Retain the original define* objects and hook identities (Zod function
    // wrappers would otherwise change the hooks' argument contracts).
    return mod.voiceRuntime as VoiceRuntimeConfig;
  } finally {
    unregister?.();
  }
}
