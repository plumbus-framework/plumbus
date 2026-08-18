# LiveKit continuous voice integration

This guide documents how to wire a continuous (always-listening) LiveKit voice
stack onto `@plumbus/voice`. Coding agents in a consumer app should open
`node_modules/@plumbus/voice/instructions/continuous-sessions.md` first (what
the runtime already does, knobs that exist, knobs that do not).

Install the transport add-on first:

```bash
pnpm add @plumbus/voice @plumbus/voice-livekit
```

It is provider- and app-agnostic: substitute your own voice name, language(s),
STT/TTS providers, and brain input. Install alone does **not** register LiveKit —
pass `LIVEKIT_TRANSPORT_REGISTRATION` into `createProviderRegistry({ transport })`
and that registry into `registerVoiceRoutes` / workers. Browser session helpers
import from `@plumbus/voice-livekit/client`; agent/worker APIs
(`startVoiceAgentWorker`, `mintLiveKitParticipantToken`, `joinVoiceRoomSession`)
import from `@plumbus/voice-livekit` (or `./worker`). See
[upgrading-voice-provider-packages.md](../upgrading-voice-provider-packages.md).

## Session minting

Use `POST /api/voice/:name/token` with a `beforeSession` hook that returns
room mint options and execution context:

```ts
beforeSession: async (ctx, voice, body) => ({
  room: {
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

The route passes `beforeSession.room` into the transport’s `mintSession()` (LiveKit via `LIVEKIT_TRANSPORT_REGISTRATION`).

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
- Soniox sessions send `language_hints_strict` automatically when exactly one
  language is hinted (the vendor's top documented accuracy lever — combined
  with the worker's per-session language narrowing, single-language sessions
  run fully restricted). Override with `stt.options.languageHintsStrict`.
- STT-input guidance: feed the recognizer raw microphone audio. Client-side
  noise cancellation (especially Krisp BVC) measurably degrades STT accuracy
  (Krisp's own benchmarks: ~2x WER on BVC-processed input); if noise
  cancellation is needed, place it off the STT path. The client mic disables
  Opus DTX and browser `voiceIsolation` for the same reason.
- `VoiceSessionController` auto-runs turns on STT endpoint/final events
- Soniox signals end-of-speech via its in-stream `<end>` control token (and the
  SDK's derived `endpoint` event); the provider forwards this as `onEndpoint`.
  Because Soniox declares `capabilities.endpointDetection`, the controller drives
  turns purely from that signal and does **not** schedule a silence-timer
  failsafe. Providers without reliable endpoint detection still use the failsafe
  (`stt.options.endpointSilenceMs`, default 4000 ms); apps can force the failsafe
  back on for any provider by setting a positive `endpointSilenceMs`.
- Optional `stt.options.endpointSensitivity` (Soniox SDK range `-1`..`1`, default
  `0`) tunes how eagerly the provider declares end-of-speech; negative values wait
  longer before emitting `<end>`.
- Optional `stt.options.endpointGraceMs` (milliseconds, default `0`) defers the
  turn after `onEndpoint` so a user who resumes speaking within the window does not
  trigger a half-finished utterance. The grace timer is cleared on new transcript
  audio, barge-in, turn start, and session teardown. If speech resumes during the
  grace window, the controller prepends the deferred utterance (captured at endpoint
  time) onto the resumed STT fragment so the full answer reaches the brain. The
  deferred fragment stays prefixed across every cumulative partial of the resumed
  utterance until a turn actually starts, and the emitted `stt.partial`/`stt.final`
  events carry the stitched text so client transcript mirrors show the full
  pending speech live.
- Speech that completes while a reply or hearing-repair prompt is still being
  spoken is **not** dropped: the controller keeps it pending (further utterances
  stitch onto it), and once the in-flight turn settles it replays the endpoint
  through the normal grace window, so an answer given over the assistant's reply
  becomes the next turn instead of silently vanishing. The replay never fires
  while a cumulative utterance is still open — the utterance's own endpoint
  delivers the stitched transcript — and never after the session is disposed or
  the transport is lost. Barge-in during a reply still discards the pending
  turn — an explicit interrupt means the user is restarting (barge-in is a
  no-op while a repair prompt plays).
- The sentence chunker always merges micro-fragments shorter than 8 characters
  into the following sentence's synthesis call, so a reply opening with a
  written hesitation ("המממ...") is synthesized with its sentence context
  instead of as an isolated fragment read as disconnected syllables. This is
  a runtime default, not a `defineVoice` / `tts.options` setting — do not add
  `minChunkChars`. Short first sentences (`כן.`, `Yes.`) wait for the next
  sentence; that delay is intended.
- Call `bargeIn()` (or send `{ type: 'barge.in' }` over LiveKit data) to
  interrupt playback
- Send `{ type: 'tts.speak', text: '<utterance>' }` over LiveKit data (or
  `session.sendControl`) to replay assistant text through server TTS without
  starting a brain turn — used for message replay in voice-enabled UIs

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
| `startVoiceAgentWorker()` | Production LiveKit agent dispatch — import from `@plumbus/voice-livekit` |
| `joinVoiceRoomSession()` | Programmatic single-room join — import from `@plumbus/voice-livekit` |

Apps typically run the worker via `plumbus voice worker` alongside the app dev
process — no app-local worker file required. The CLI dynamically imports
`@plumbus/voice-livekit` and loads `app/voice/registry.ts` via
`loadAppVoiceRegistry()` (`voiceProviderRegistry` + optional `voiceProviders`).
`startVoiceAgentWorker()` calls LiveKit's `initializeLogger()` before
constructing `AgentServer` (required by `@livekit/agents` 1.4.x).

## Client

```ts
import { createLiveKitVoiceSession } from '@plumbus/voice-livekit/client';

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
