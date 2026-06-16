# Dvora LiveKit integration

This guide documents how MemoirAi-style Dvora voice stacks map onto `@plumbus/voice`.

## Session minting

Use `POST /api/voice/:name/token` with a `beforeSession` hook that returns LiveKit room metadata and execution context:

```ts
beforeSession: async (ctx, voice, body) => ({
  livekit: {
    roomName: sessionId,
    identity: userId,
    tokenTtlSeconds: 3600,
    metadata: { projectId, language: 'he' },
    attributes: { tenantId },
  },
  execution: {
    userId,
    tenantId,
    input: { projectId },
  },
}),
```

The route passes `beforeSession.livekit` into `LiveKitTransportProvider.mintSession()`.

## Agent audio track

Server workers publish assistant audio on `dvora-voice` by default. Override per voice:

```ts
transport: {
  provider: 'livekit',
  mode: 'continuous',
  options: {
    agentAudioTrackName: 'dvora-voice',
    roomResolver: ({ sessionId }) => sessionId,
  },
},
```

## Continuous conversation

- Set `transport.mode: 'continuous'`
- Use Soniox with endpoint detection (`enableEndpointDetection: true`)
- Optional `stt.options.contextTerms` for Soniox `context.terms` (domain vocabulary)
- `VoiceSessionController` auto-runs turns on STT endpoint/final events
- Call `bargeIn()` (or send `{ type: 'barge.in' }` over LiveKit data) to interrupt playback

## Streaming brain + TTS

`runVoiceTurn()` uses `runStreamingTurnPipeline()` when the TTS provider supports streaming. Assistant deltas are sentence-chunked (Hebrew sof pasuq, paragraphs, 200-char max) and synthesized concurrently.

## Workers

| Command | Use case |
|---|---|
| `plumbus voice worker --room <sessionId>` | Dev worker joins a specific room |
| `startVoiceAgentWorker()` | Production LiveKit agent dispatch via `@livekit/agents` |
| `joinVoiceRoomSession()` | Programmatic single-room join |

Export `createVoiceAgentEntry()` from `app/voice/worker.ts` for production agent dispatch.

## Client

```ts
import { createLiveKitVoiceSession } from '@plumbus/voice/client';

const session = await createLiveKitVoiceSession({
  voiceName: 'dvora',
  tokenUrl: '/api/voice/dvora/token',
  authHeader: `Bearer ${appToken}`,
  onEvent: (event) => console.log(event),
  onAudioChunk: (pcm16) => playPcm16(pcm16), // pcm16;rate=16000;channels=1
});
await session.connect();

// Push-to-talk over LiveKit data channel
await session.ptt.down();
await session.ptt.up({ transcript: 'optional client transcript' });
```

Requires optional peer dependency `livekit-client`. Agent audio captured from the subscribed track is resampled to 16 kHz mono PCM16 before `onAudioChunk`.
