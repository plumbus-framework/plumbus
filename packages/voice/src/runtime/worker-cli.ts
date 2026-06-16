import { discoverVoices } from '../discover/discover-voices.js';
import { resolveVoiceProvidersFromEnv } from '../config/resolve-voice-providers.js';
import { joinVoiceRoomSession } from './worker.js';

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Usage: node --import tsx packages/voice/src/runtime/worker-cli.ts [--room <roomName>]');
    console.log('Joins a LiveKit room using discovered app/voices definitions.');
    return;
  }

  const roomIndex = process.argv.indexOf('--room');
  const roomName = roomIndex >= 0 ? process.argv[roomIndex + 1] : process.env.VOICE_AGENT_ROOM;
  if (!roomName) {
    throw new Error('Specify --room <roomName> or set VOICE_AGENT_ROOM');
  }

  const voices = await discoverVoices();
  const voice = voices.find((candidate) => candidate.transport.provider === 'livekit');
  if (!voice) {
    throw new Error('No livekit voice definitions found under app/voices/');
  }

  const providers = resolveVoiceProvidersFromEnv();
  const handle = await joinVoiceRoomSession({
    voice,
    providers,
    roomName,
    sessionId: roomName,
    createExecutionContext: () => {
      throw new Error('worker-cli requires app-specific createExecutionContext wiring via plumbus voice worker');
    },
  });

  console.log(`Voice worker connected to room ${roomName} (session ${handle.sessionId})`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
