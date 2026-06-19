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
import { onRoutesRegistered } from '@plumbus/core';

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

onRoutesRegistered((app, routeConfig) => {
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
});
```

## Required fields

| Field | Why it exists |
|---|---|
| `name` | stable route/session identifier |
| `access` | voice routes are deny-by-default |
| `transport` | realtime session strategy (`websocket` or `livekit`) |
| `stt` | transcript source/provider |
| `tts` | synthesis provider |
| `brain.run` | app logic hook |

## Tone hooks

Two hooks shape delivery without leaking provider-specific knobs into app code:

- `toneProfiles`: named presets like `calm`, `energetic`, `reassuring`
- `resolveTone(ctx, args)`: choose a profile or inline `DeliveryTone` for the current turn

The runtime resolves the tone once, then each TTS adapter maps it through `mapDeliveryTone(...)`.

`DeliveryTone` carries the delivery axes (`pace`, `warmth`, `energy`, `emotion`) plus an
optional `targetGender`. Returning a `targetGender` from `resolveTone` lets an app drive the
synthesized voice gender per turn — e.g. reading an already-detected subject gender from
`ctx` and returning `{ profile, targetGender }`. Adapters that support a gender control
(Deepdub) prefer this per-turn value over their statically configured voice option and fall
back to the static option when it is absent; adapters without a gender control ignore it.

## `preprocessForTts`

Use `preprocessForTts(text, ctx)` for last-mile normalization before synthesis, for example:

- stripping formatting artifacts
- expanding shorthand
- localizing abbreviations

Do **not** move business logic here. Keep it in `brain.run`.

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
| `tts.speak` | client TTS instruction (`browser-tts`) |
| `turn.completed` / `turn.failed` | turn outcome |
| `error` | structured failure (`transport_lost`, budget exceeded, etc.) |

Server STT adapters wire `onTranscript` into `stt.partial` / `stt.final`. TTS playback uses `Playing` once audio chunks (or `tts.speak`) begin.

For LiveKit transports, clients use `createLiveKitVoiceSession()` (`@plumbus/voice/client`) to subscribe to the agent audio track and receive JSON control events. Agent audio is delivered as 16 kHz mono PCM16 via `onAudioChunk`; push-to-talk uses `session.ptt.down()` / `session.ptt.up()` data messages (or `{ type: 'ptt.down' }` / `{ type: 'ptt.up' }` on raw data channels).

## Related docs

- [configuration.md](./configuration.md)
- [providers.md](./providers.md)
- [security.md](./security.md)
