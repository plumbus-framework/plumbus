# LiveKit continuous voice integration

This guide documents how to wire a continuous (always-listening) LiveKit voice
stack onto `@plumbus/voice`. It is provider- and app-agnostic: substitute your
own voice name, language(s), STT/TTS providers, and brain input.

## Session minting

Use `POST /api/voice/:name/token` with a `beforeSession` hook that returns
LiveKit room metadata and execution context:

```ts
beforeSession: async (ctx, voice, body) => ({
  livekit: {
    roomName: sessionId,
    identity: userId,
    tokenTtlSeconds: 3600,
    // App-defined metadata forwarded to the agent (see participant context below).
    metadata: { sessionId, language: 'en' },
    attributes: { tenantId },
  },
  execution: {
    userId,
    tenantId,
    // App-defined brain input keys.
    input: { sessionId },
  },
}),
```

The route passes `beforeSession.livekit` into `LiveKitTransportProvider.mintSession()`.

Browser participant tokens include LiveKit agent dispatch in the JWT `roomConfig`:

```json
{
  "roomConfig": {
    "agents": [{ "agentName": "<voice-name>", "metadata": "{\"sessionId\":\"...\",\"language\":\"en\"}" }]
  }
}
```

`mintSession()` sets `agentName` to the voice name so `plumbus voice worker` is
dispatched when the browser joins. Worker participant tokens from
`connectWorker()` omit `roomConfig` to avoid recursive dispatch.

## Participant context

The worker parses LiveKit participant metadata into a typed session context and
forwards a small set of well-known fields to the brain when present:
`sessionId`, `tenantId`, `language`, and `projectId`. Anything else you put in
`metadata` is preserved and passed through. Use these to thread app identifiers
(such as a session or project id) and the recognition language into your brain
hook without coupling the framework to your domain.

## Agent child-process bootstrap

LiveKit runs the default agent entry in a forked child process. The parent
registers runtime config in memory, but the child starts with an empty registry.
`plumbus voice worker` sets `PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE` to
`@plumbus/core`'s `dist/cli/voice-agent-bootstrap.js`, which exports
`bootstrapVoiceAgentRuntime()`. On the first dispatched job, the child imports
that module, discovers `app/voices/*`, resolves providers from env, and builds
Plumbus `createDependencies` before handling audio/STT.

`@plumbus/core` emits that file via `pnpm run build:voice-cli`. Apps that link
the framework packages locally (file/workspace deps) must run that build (and
rebuild `@plumbus/voice`) before `pnpm install` so the pnpm file-dependency
snapshot includes the bootstrap module.

The child process inherits the worker environment, so AI provider env such as
`AI_DEFAULT_PROVIDER` and `AI_OPENAI_API_KEY` must be present on
`plumbus voice worker`. The bootstrap loads app server extensions
(`app/server.ts`) so DB-backed `resolveAiOverrides` and prompt overrides are
available to the voice brain.

## Agent audio track

Server workers publish assistant audio on the `agent-voice` track by default.
Override per voice with `agentAudioTrackName`:

```ts
transport: {
  provider: 'livekit',
  mode: 'continuous',
  options: {
    agentAudioTrackName: 'agent-voice',
    roomResolver: ({ sessionId }) => sessionId,
  },
},
```

## Continuous conversation

- Set `transport.mode: 'continuous'`
- Use an STT provider with endpoint detection (e.g. Soniox with
  `enableEndpointDetection: true`)
- The worker narrows STT `language_hints` from participant metadata
  (`language: '<code>'`) and enables strict hints for the session, so a
  single-language project defaults to that language's recognition.
- Optional `stt.options.contextTerms` supplies domain vocabulary to providers
  that support a context/terms bias.
- `VoiceSessionController` auto-runs turns on STT endpoint/final events
- Call `bargeIn()` (or send `{ type: 'barge.in' }` over LiveKit data) to
  interrupt playback

### Sensitive listening and hearing repair

Voices can enable STT input normalization before audio reaches the provider:

```ts
stt: {
  options: {
    enableInputNormalization: true,
    targetRmsDb: -24,
    maxGainDb: 18,
    inputGainDb: 3,
    lowConfidenceThreshold: 0.55,
    contextTerms: ['<domain-term>', '<domain-term>'],
  },
},
```

`VoiceSessionController` logs PCM peak/RMS for the first useful frame and warns
on sustained low input levels. When the STT endpoint fires with no transcript,
or a final transcript is empty / low-confidence / looks like an uncertain proper
name, the controller can speak a short, app-supplied repair prompt via TTS only
(no brain turn persisted) — for example "I didn't catch that, can you say it
again?", a low-confidence variant, and a "can you spell that name?" variant. The
prompt text is owned by the app, in whatever language(s) it supports.

STT token `confidence` and `language` metadata are forwarded on `stt.partial` /
`stt.final` events when the provider supplies them.

## Streaming brain + TTS

`runVoiceTurn()` uses `runStreamingTurnPipeline()` when the TTS provider supports
streaming. Assistant deltas are sentence-chunked (sentence terminators,
paragraphs, 200-char max) and synthesized concurrently.

TTS providers stream PCM. When a provider's SDK emits a container format (such as
`wav`), the adapter strips the container header and forwards raw PCM frames — the
LiveKit agent track publishes PCM, so container formats must never be forwarded
directly as realtime room audio. The agent's output track sample rate is taken
from `tts.options.sampleRate` (decoupled from the STT input rate); the worker
builds `pcm16;rate=<sampleRate>;channels=1` for the published track and defaults
to 16 kHz when unset. Set `sampleRate` to the provider's native synthesis rate
to avoid resampling artifacts.

## Workers

| Command | Use case |
|---|---|
| `plumbus voice worker` | Production/dev agent dispatch (auto-joins rooms) |
| `plumbus voice worker --room <sessionId>` | Dev worker joins a specific room |
| `startVoiceAgentWorker()` | Production LiveKit agent dispatch via `@livekit/agents` |
| `joinVoiceRoomSession()` | Programmatic single-room join |

Apps typically run the worker via `plumbus voice worker` alongside the app dev
process — no app-local worker file required. `startVoiceAgentWorker()` calls
LiveKit's `initializeLogger()` before constructing `AgentServer` (required by
`@livekit/agents` 1.4.x).

## Client

```ts
import { createLiveKitVoiceSession } from '@plumbus/voice/client';

const session = await createLiveKitVoiceSession({
  voiceName: '<voice-name>',
  tokenUrl: '/api/voice/<voice-name>/token',
  authHeader: `Bearer ${appToken}`,
  tokenRequestBody: { sessionId, language: 'en' },
  onEvent: (event) => console.log(event),
  onAudioChunk: (pcm16) => playPcm16(pcm16), // pcm16;rate=16000;channels=1
});
await session.connect();

// Push-to-talk over LiveKit data channel
await session.ptt.down();
await session.ptt.up({ transcript: 'optional client transcript' });
```

Requires optional peer dependency `livekit-client`. Agent audio is played through
a single hidden `HTMLMediaElement` attached to the subscribed agent track
(canonical LiveKit playback). Reconnects and duplicate `TrackSubscribed` events
remove stale sinks before attaching the next one. Optional `onAudioChunk`
receives resampled 16 kHz mono PCM16 for diagnostics/visualization only — it must
not be the audible playback path.
