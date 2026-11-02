import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { createErrorService } from '../../errors/index.js';
import type { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { loadVoiceWorkerDefinitions } from '../voice-worker-definitions.js';
import { info } from '../utils.js';

async function loadVoiceRuntime(): Promise<typeof import('@plumbus/voice/session')> {
  try {
    return await import('@plumbus/voice/session');
  } catch {
    console.error('');
    console.error('Voice runtime not installed.');
    console.error('Run: pnpm add @plumbus/voice');
    console.error('');
    process.exit(1);
  }
}

/** Minimal surface used by `plumbus voice worker` — typed locally to avoid a core→livekit type graph. */
interface VoiceLiveKitCliModule {
  startVoiceAgentWorker(options: {
    voices: unknown[];
    providers: unknown;
    createDependencies?: (auth: {
      userId: string;
      tenantId?: string;
      roles: string[];
      scopes: string[];
      provider: string;
    }) => unknown;
    agentName?: string;
    bootstrapModule?: string;
    registry?: unknown;
  }): Promise<{ stop(): Promise<void> }>;
  joinVoiceRoomSession(options: {
    voice: unknown;
    providers: unknown;
    roomName: string;
    sessionId: string;
    registry?: unknown;
    createExecutionContext: (args: {
      userId?: string;
      tenantId?: string;
      metadata?: Record<string, unknown>;
    }) => unknown;
  }): Promise<{ stop(): Promise<void> }>;
}

async function loadVoiceLiveKitRuntime(): Promise<VoiceLiveKitCliModule> {
  try {
    const pkg: string = '@plumbus/voice-livekit';
    return (await import(pkg)) as VoiceLiveKitCliModule;
  } catch {
    console.error('');
    console.error('LiveKit voice add-on not installed.');
    console.error('Run: pnpm add @plumbus/voice-livekit');
    console.error('');
    process.exit(1);
  }
}

export interface VoiceWorkerOptions {
  room?: string;
  voice?: string;
  compiled?: string;
}

export function isVoiceWorkerDisabled(): boolean {
  return process.env.VOICE_AGENT_ENABLED === 'false';
}

export type VoiceWorkerBranch = 'agent-dispatch' | 'join-room';

export function resolveVoiceWorkerBranch(opts: VoiceWorkerOptions): VoiceWorkerBranch {
  const roomName = opts.room ?? process.env.VOICE_AGENT_ROOM;
  return roomName ? 'join-room' : 'agent-dispatch';
}

export function resolveVoiceAgentBootstrapModulePath(): string {
  return fileURLToPath(new URL('../voice-agent-bootstrap.js', import.meta.url));
}

export function ensureVoiceAgentBootstrapEnv(): void {
  if (!process.env.PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE) {
    process.env.PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE = resolveVoiceAgentBootstrapModulePath();
  }
}

export function registerVoiceCommand(program: Command): void {
  const voice = program.command('voice').description('Realtime voice worker and tooling');

  voice
    .command('build')
    .description('Compile scoped voice application modules for production workers')
    .option('--out-dir <directory>', 'Empty output directory', '.plumbus/voice-build')
    .action(async (options: { outDir: string }) => {
      const { buildVoiceApplication } = await import('../voice-build.js');
      await buildVoiceApplication(process.cwd(), resolve(options.outDir));
      info(`Voice application built in ${resolve(options.outDir)}`);
    });

  voice
    .command('worker')
    .description('Join a LiveKit voice room as the agent worker (dev: --room <sessionId>)')
    .option('--room <room>', 'LiveKit room name to join (typically interview sessionId)')
    .option('--voice <name>', 'Voice definition name to use')
    .option('--compiled <directory>', 'Run a compiled voice application without TypeScript loaders')
    .action(async (opts: VoiceWorkerOptions) => {
      if (isVoiceWorkerDisabled()) {
        info('Voice worker disabled (VOICE_AGENT_ENABLED=false)');
        process.exit(0);
      }

      if (opts.compiled) {
        const root = resolve(opts.compiled);
        let valid = false;
        try {
          valid = z
            .object({ version: z.literal(1) })
            .safeParse(JSON.parse(readFileSync(resolve(root, 'voice-build.json'), 'utf8'))).success;
        } catch {
          /* Report the same structured error for missing or malformed output. */
        }
        if (!valid)
          throw createErrorService().validation(
            'Invalid compiled voice directory; run plumbus voice build first',
          );
        process.env.PLUMBUS_VOICE_APP_ROOT = root;
        process.env.PLUMBUS_VOICE_JAVASCRIPT_ONLY = 'true';
      }
      const livekitPkg = await loadVoiceLiveKitRuntime();
      const branch = resolveVoiceWorkerBranch(opts);

      if (branch === 'agent-dispatch') {
        const ctx = await loadVoiceWorkerDefinitions();
        info('Starting LiveKit voice agent dispatch worker');
        ensureVoiceAgentBootstrapEnv();
        const handle = await livekitPkg.startVoiceAgentWorker({
          voices: ctx.voices,
          providers: ctx.providers,
          agentName: opts.voice,
          bootstrapModule: process.env.PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE,
          registry: ctx.registry,
        });

        const shutdown = async () => {
          await handle.stop();
          process.exit(0);
        };

        process.on('SIGINT', () => {
          void shutdown();
        });
        process.on('SIGTERM', () => {
          void shutdown();
        });

        info('Voice agent dispatch worker running — press Ctrl+C to stop');
        return;
      }

      const voicePkg = await loadVoiceRuntime();
      const { buildVoiceServeContext } = await import('../voice-serve-context.js');
      const ctx = await buildVoiceServeContext();
      const selectedVoice =
        ctx.voices.find((candidate) => candidate.name === opts.voice) ??
        ctx.voices.find((candidate) => candidate.transport.provider === 'livekit');

      if (!selectedVoice) {
        console.error('No livekit voice definitions found under app/voices/');
        process.exit(1);
      }

      info(
        `Joining LiveKit room ${opts.room ?? process.env.VOICE_AGENT_ROOM} as voice "${selectedVoice.name}"`,
      );

      const roomName = opts.room ?? process.env.VOICE_AGENT_ROOM ?? '';
      const handle = await livekitPkg.joinVoiceRoomSession({
        voice: selectedVoice,
        providers: ctx.providers,
        roomName,
        sessionId: roomName,
        registry: ctx.registry,
        createExecutionContext: ({ userId, tenantId, metadata }) => {
          const resolvedUserId =
            userId ??
            (typeof metadata?.userId === 'string' ? metadata.userId : undefined) ??
            'voice-worker';
          const resolvedTenantId =
            tenantId ??
            (typeof metadata?.tenantId === 'string' ? metadata.tenantId : undefined) ??
            'default';
          return voicePkg.createVoiceExecutionContext(ctx.routeConfig, {
            userId: resolvedUserId,
            tenantId: resolvedTenantId,
          });
        },
      });

      const shutdown = async () => {
        await handle.stop();
        await ctx.closeQueues();
        await ctx.closeDb();
        process.exit(0);
      };

      process.on('SIGINT', () => {
        void shutdown();
      });
      process.on('SIGTERM', () => {
        void shutdown();
      });

      info('Voice worker connected — press Ctrl+C to stop');
    });
}
