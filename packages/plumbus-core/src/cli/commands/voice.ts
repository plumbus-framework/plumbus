// ── plumbus voice ──

import type { Command } from 'commander';
import { buildVoiceServeContext } from '../voice-serve-context.js';
import { info } from '../utils.js';

async function loadVoiceRuntime(): Promise<typeof import('@plumbus/voice')> {
  try {
    return await import('@plumbus/voice');
  } catch {
    console.error('');
    console.error('Voice runtime not installed.');
    console.error('Run: pnpm add @plumbus/voice');
    console.error('');
    process.exit(1);
  }
}

export interface VoiceWorkerOptions {
  room?: string;
  voice?: string;
}

export function registerVoiceCommand(program: Command): void {
  const voice = program.command('voice').description('Realtime voice worker and tooling');

  voice
    .command('worker')
    .description('Join a LiveKit voice room as the agent worker (dev: --room <sessionId>)')
    .option('--room <room>', 'LiveKit room name to join (typically interview sessionId)')
    .option('--voice <name>', 'Voice definition name to use')
    .action(async (opts: VoiceWorkerOptions) => {
      if (process.env.VOICE_AGENT_ENABLED === 'false') {
        console.error('Voice worker disabled (VOICE_AGENT_ENABLED=false)');
        process.exit(1);
      }

      const voicePkg = await loadVoiceRuntime();
      const ctx = await buildVoiceServeContext();
      const roomName = opts.room ?? process.env.VOICE_AGENT_ROOM;

      if (!roomName) {
        console.error(
          'Specify --room <sessionId> or set VOICE_AGENT_ROOM. For production agent dispatch, export createVoiceAgentEntry() from app/voice/worker.ts.',
        );
        process.exit(1);
      }

      const selectedVoice =
        ctx.voices.find((candidate) => candidate.name === opts.voice) ??
        ctx.voices.find((candidate) => candidate.transport.provider === 'livekit');

      if (!selectedVoice) {
        console.error('No livekit voice definitions found under app/voices/');
        process.exit(1);
      }

      info(`Joining LiveKit room ${roomName} as voice "${selectedVoice.name}"`);

      const handle = await voicePkg.joinVoiceRoomSession({
        voice: selectedVoice,
        providers: ctx.providers,
        roomName,
        sessionId: roomName,
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
