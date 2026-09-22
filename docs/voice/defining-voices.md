# Defining Voices

`defineVoice({...})` is the declarative entrypoint for a speech surface in Plumbus. One voice definition answers four questions:

1. who is allowed to use it (`access`)
2. how audio moves (`transport`)
3. how speech becomes text (`stt`)
4. how the assistant response becomes audio (`tts`)

The app-owned brain stays inside `brain.run(ctx, args)`.

## Minimal example

```ts
import { defineVoice, registerVoiceRoutes } from '@plumbus/voice';

export const interviewVoice = defineVoice({
  name: 'interview',
  access: { roles: ['subject'] },
  transport: { provider: 'websocket', mode: 'pushToTalk' },
  stt: { provider: 'web-speech', languages: ['en-US'] },
  tts: { provider: 'browser-tts', locale: 'en-US', voiceId: 'default' },
  brain: {
    async run(ctx, args) {
      return {
        text: `Tell me more about ${args.transcript ?? 'that'}.`,
      };
    },
  },
});

// app/server.ts — export the hook; the runtime loads it from your app module
export function onRoutesRegistered(app, routeConfig) {
  registerVoiceRoutes(app, routeConfig, [interviewVoice], {
    providers: {
      providers: {
        websocket: {},
        'web-speech': {},
        'browser-tts': {},
      },
    },
    sessionTokenSecret: process.env['VOICE_SESSION_TOKEN_SECRET'],
    websocketOriginAllowlist: ['https://app.example.com'],
  });
}
```

## Required fields

| Field | Why it exists |
|---|---|
| `name` | stable route/session identifier |
| `access` | voice routes are deny-by-default |
| `transport` | realtime session strategy (`websocket` built-in, or `livekit` with `@plumbus/voice-livekit` installed) |
| `stt` | transcript source/provider |
| `tts` | synthesis provider |
| `brain.run` | app logic hook |

## Tone hooks

Two hooks shape delivery without leaking provider-specific knobs into app code:

- `toneProfiles`: named presets like `calm`, `energetic`, `reassuring`
- `resolveTone(ctx, args)`: choose a profile or inline `DeliveryTone` for the current turn

The runtime resolves the tone once, then each TTS adapter maps it through `mapDeliveryTone(...)`.

`DeliveryTone` carries the delivery axes (`pace`, `warmth`, `energy`, `emotion`) plus an
optional `targetGender` and an optional `voiceId`. Returning a `targetGender` from
`resolveTone` lets an app drive the synthesized voice gender per turn — e.g. reading an
already-detected subject gender from `ctx` and returning `{ profile, targetGender }`.
Adapters that support a gender control (Deepdub) prefer this per-turn value over their
statically configured voice option and fall back to the static option when it is absent;
adapters without a gender control ignore it.

`voiceId` selects a per-turn voice for this delivery — the mechanism for emotional
**style-variant switching** on providers whose voices ship as families of style prompts of
the same speaker (Deepdub: one `voicePromptId` per emotional register, switched per call).
Declare it on a tone profile or return it from `resolveTone`; the Deepdub adapter prefers
it over the static `tts.voiceId` and falls back when absent. Providers without per-call
voice selection ignore it.

## Hearing repair hook

When the session controller detects an utterance it may not have heard — an
endpoint with no transcript after speech energy (`reason: 'empty'`), or any
transcript below the configured confidence threshold (`reason:
'low_confidence'`) — it can speak a short repair prompt instead of starting a
brain turn. The framework owns only the signals and the mechanism (detection,
timing, playback, cost recording); it never judges what a transcript *is*. The
app owns every content decision through `onHearingRepair`:

```ts
defineVoice({
  // ...
  onHearingRepair: async (ctx, { reason, transcript, confidence, language, sessionId }) => {
    if (reason === 'low_confidence' && !looksLikeAName(transcript)) {
      return undefined; // not name-shaped: no repair, the turn proceeds normally
    }
    // Return the text to speak, optionally with a delivery tone...
    return {
      text: language?.startsWith('en') ? 'Could you say that again?' : 'אפשר לחזור שוב?',
      tone: { profile: 'apologetic_repair', targetGender: await lookupGender(ctx, sessionId) },
    };
    // ...a bare string for text only, or undefined/null to suppress the repair speech.
  },
});
```

- The `tone` result is resolved against `toneProfiles` and mapped through the
  TTS adapter's `mapDeliveryTone(...)` exactly like a `resolveTone` result, so
  repair speech can carry `targetGender` / `voiceId` style-variant selection
  without the framework knowing anything about the app's data model.
- A suppressed (or hookless) `low_confidence` signal is not a dropped turn:
  the transcript stands and becomes a normal brain turn.
- A hook that throws falls back to the built-in default line for `empty`
  (the session must not go silent because app code failed); for
  `low_confidence` there is no default — the turn proceeds.
- When `onHearingRepair` is absent, only `empty` speaks the framework's
  built-in Hebrew/English default line; `low_confidence` produces no repair.

## `preprocessForTts`

Use `preprocessForTts(text, ctx)` for last-mile normalization before synthesis, for example:

- stripping formatting artifacts
- expanding shorthand
- localizing abbreviations

Do **not** move business logic here. Keep it in `brain.run`.

Streaming TTS always merges sentence chunks shorter than 8 characters into the
next sentence. That is not configurable from `defineVoice`. Do not add
`minChunkChars`.

Optional mid-utterance continuers are opt-in: `stt.options.backchannelEnabled`.
See [configuration.md](./configuration.md) and
[livekit-continuous-voice.md](./livekit-continuous-voice.md). Continuous
server-STT session behavior (talk-over re-queue, stitched `stt.partial` /
`stt.final`) is documented there too.

## Worker/bootstrap notes

Voice routes do not invent a separate application model. They reuse the same dependency factory as the rest of the app (`routeConfig.createDependencies(auth)`), so:

- auth context stays aligned with your normal routes
- `ctx.ai.recordProviderCost()` writes into the same ledger
- the same app services/config are available inside `brain.run`

If you run voice work in a separate process later, keep the dependency factory shared so auth, cost, and configuration do not drift.

## Event protocol (v1 PTT)

Clients and servers exchange JSON control frames (and binary audio on WebSocket transport). Common events:

| Event | Meaning |
|---|---|
| `session.hello` | session bootstrap; includes `sttMode` (`client` \| `server`) |
| `stt.partial` | streaming server STT transcript update |
| `stt.final` | finalized transcript for the current utterance |
| `ptt.down` / `ptt.up` | push-to-talk lifecycle |
| `assistant.delta` | streamed assistant text from `brain.run` |
| `agent.state` | `Idle`, `Listening`, `Transcribing`, `AwaitingLLM`, `Synthesizing`, `Playing` |
| `agent.tone` | active tone profile id (debug/UX) |
| `tts.speak` | client TTS instruction (`browser-tts`), or server TTS when sent as a **control** frame (`{ type: 'tts.speak', text }`) to replay assistant text without a brain turn |
| `turn.completed` / `turn.failed` | turn outcome |
| `error` | structured failure (`transport_lost`, budget exceeded, etc.) |

Server STT adapters wire `onTranscript` into `stt.partial` / `stt.final`. TTS playback uses `Playing` once audio chunks (or `tts.speak`) begin.

For LiveKit transports, clients use `createLiveKitVoiceSession()` (`@plumbus/voice-livekit/client`) to subscribe to the agent audio track and receive JSON control events. Agent audio is delivered as 16 kHz mono PCM16 via `onAudioChunk`; push-to-talk uses `session.ptt.down()` / `session.ptt.up()` data messages (or `{ type: 'ptt.down' }` / `{ type: 'ptt.up' }` on raw data channels).

## Related docs

- [configuration.md](./configuration.md)
- [providers.md](./providers.md)
- [security.md](./security.md)
