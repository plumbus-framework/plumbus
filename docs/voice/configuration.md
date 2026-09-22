# Voice Configuration

`registerVoiceRoutes()` receives a `VoiceProvidersConfig` object. Its keys mirror provider ids and carry the credential/config material needed to instantiate those providers.

## Shape

```ts
const providers = {
  providers: {
    websocket: {},
    livekit: {
      url: process.env['LIVEKIT_URL'],
      apiKey: process.env['LIVEKIT_API_KEY'],
      apiSecret: process.env['LIVEKIT_API_SECRET'],
    },
    soniox: {
      apiKey: process.env['SONIOX_API_KEY'],
    },
    'openai-whisper': {
      apiKey: process.env['OPENAI_API_KEY'],
      baseUrl: process.env['OPENAI_BASE_URL'],
    },
    'openai-realtime': {
      apiKey: process.env['OPENAI_API_KEY'],
      baseUrl: process.env['OPENAI_BASE_URL'],
    },
    deepdub: {
      apiKey: process.env['DEEPDUB_API_KEY'],
      baseUrl: process.env['DEEPDUB_BASE_URL'],
    },
    openai: {
      apiKey: process.env['OPENAI_API_KEY'],
      baseUrl: process.env['OPENAI_BASE_URL'],
    },
    minimax: {
      apiKey: process.env['MINIMAX_API_KEY'],
      baseUrl: process.env['MINIMAX_BASE_URL'],
      // optional — required by some MiniMax account setups
      options: { groupId: process.env['MINIMAX_GROUP_ID'] },
    },
    elevenlabs: {
      apiKey: process.env['ELEVENLABS_API_KEY'],
      baseUrl: process.env['ELEVENLABS_BASE_URL'],
    },
    'web-speech': {},
    'browser-tts': {},
  },
} satisfies VoiceProvidersConfig;
```

## Credential summary

| Provider | Install | Required fields | Notes |
|---|---|---|---|
| `websocket` | built-in | none | raw app-owned websocket transport |
| `livekit` | `@plumbus/voice-livekit` | `url`, `apiKey`, `apiSecret` | separate secret from app auth |
| `soniox` | `@plumbus/voice-soniox` | `apiKey` | STT and/or TTS; optional STT `options.contextTerms` → Soniox `context.terms` |
| `openai-whisper` | `@plumbus/voice-openai` | `apiKey` | official `openai` SDK; use `baseUrl` / `OPENAI_BASE_URL` for OpenAI-compatible Whisper endpoints |
| `openai-realtime` | `@plumbus/voice-openai` | `apiKey` | STT-only Realtime transcription via SDK (`OpenAIRealtimeWS`); connection model defaults to `gpt-realtime` (`stt.options.realtimeConnectionModel`); transcription model is `stt.model`; not full speech-to-speech |
| `deepdub` | `@plumbus/voice-deepdub` | `apiKey` | streaming/server TTS |
| `openai` | `@plumbus/voice-openai` | `apiKey` | official `openai` SDK TTS; same `baseUrl` override for compatible speech endpoints |
| `minimax` | `@plumbus/voice-minimax` | `apiKey` | server TTS, richer tone mapping; optional `options.groupId` / `MINIMAX_GROUP_ID`; optional TTS options `textNormalization`, `forceCbr`, `voiceModify` |
| `elevenlabs` | `@plumbus/voice-elevenlabs` | `apiKey` | flash vs v3 via official SDK |
| `web-speech` | built-in | none | client STT |
| `browser-tts` | built-in | none | client TTS |

## Validation

Use `validateVoiceProviders({ voices, providers, registry })` to fail fast before serving traffic. Pass the same `registry` you built with explicit `*_REGISTRATION` entries so missing add-ons are reported as issues with `field: 'package'`. Without `registry`, validation only checks credential shape against the static catalog.

## Catalog/admin routes

`registerVoiceRoutes()` also mounts admin-only discovery routes:

- `GET /api/voice/catalog`
- `GET /api/voice/catalog/:kind/:providerId/options`
- `GET /api/voice/stacks`

These are meant for internal/admin tooling such as voice setup screens and should never be anonymous.

## App configuration guidance

- keep provider secrets in server-side config only
- provide `sessionTokenSecret` separately from vendor credentials
- set `websocketOriginAllowlist` explicitly in production
- if you run behind a proxy, configure `trustProxy` on the core server so IP-based policies remain meaningful

## Reusing core OpenAI credentials

When STT/TTS providers are OpenAI-backed, bridge from your existing Plumbus bootstrap config instead of duplicating keys:

```ts
import { resolveVoiceOpenAICredentials } from '@plumbus/voice-openai';

const openai = resolveVoiceOpenAICredentials(plumbusConfig);
const providers = {
  providers: {
    openai,
    'openai-whisper': openai,
    'openai-realtime': openai,
  },
};
```

### Soniox STT context terms

For domain vocabulary (product names, Hebrew proper nouns), pass `contextTerms` on the voice STT slice:

```ts
stt: {
  provider: 'soniox',
  model: 'stt-rt-v5',
  languages: ['he'],
  options: {
    contextTerms: ['AcmeApp', 'ProductName'],
    enableEndpointDetection: true,
    maxEndpointDelayMs: 3000,
    // default: true when `languages` has exactly one entry
    // languageHintsStrict: false,
  },
},
```

The Soniox adapter maps this to `context.terms` in the realtime websocket config.
A single hinted language also sends `language_hints_strict` (vendor accuracy
default). Override with `stt.options.languageHintsStrict`. Multi-language
sessions stay unrestricted unless that option is set `true`.
For raw PCM streams, it also sends `audio_format`, `sample_rate`, and `num_channels`
so Soniox can decode the forwarded LiveKit audio frames.

### Backchannel continuers

Opt-in audio-only acknowledgements during a reflective pause, without a brain
turn. Default is **off**.

```ts
stt: {
  options: {
    backchannelEnabled: true,
    backchannelPauseMs: 900,
    backchannelMinTranscriptChars: 40,
    backchannelCooldownMs: 6000,
    backchannelPhrases: ['mm-hm', 'I see'],
    // Or language-keyed pools (selected from detected/session language):
    // backchannelPhrases: { he: ['מהמ', 'כן'], en: ['mm-hm', 'I see'] },
  },
},
```

`VoiceSessionController` detects reflective pauses from per-chunk speech energy
and speaks a random phrase from the pool via TTS. Continuers do not emit
`assistant.delta` or flip agent state to `Playing`. They are suppressed during
endpoint grace, an in-flight turn or repair, and after `dispose()` / transport
loss; resume speech aborts an in-flight continuer. Isolated one-syllable
particles can be mangled by TTS providers — prefer multi-character phrases.

## Route options

`registerVoiceRoutes()` also accepts:

- `sessionBudget` / `sessionLifecycle` — per-session caps and idle/max-duration teardown
- `enableDebugEventStream` — admin-only SSE heartbeat at `GET /api/voice/:name/debug/events`
- `beforeSession` / `afterSession` — app hooks around session minting

## Voice clone routes

`registerVoiceCloneRoutes(app, routeConfig, opts)` is separate from `registerVoiceRoutes` (keeps Fastify optional). Register `@fastify/multipart` on the app before create / synthesize-reference uploads — missing multipart yields a clear dependency error.

Required opts: `access`, `resolveCloneOwner`, `afterCloneCreate`, `listOwnedClones`. Optional `referenceAccess` registers the Deepdub-style preview route. Deepdub session TTS with `tts.options.voiceReference` uses HTTP `generateToBuffer` wrapped as a **one-shot** async iterable (non-streaming for that utterance — not for manuscripts).

Full lifecycle, ownership, and spoofing guidance: [voice-cloning.md](./voice-cloning.md).

## Related docs

- [providers.md](./providers.md)
- [security.md](./security.md)
- [voice-cloning.md](./voice-cloning.md)

## Per-utterance transcript limit

`defineVoice({ transcript: { maxChars: 30_000 }, ... })` sets the maximum trimmed transcript length before the brain is invoked. The default stays 4,000. The value must be a finite positive safe integer; zero, negative, fractional and non-finite values are rejected at definition time. Length uses JavaScript UTF-16 code units, not tokens, bytes or audio duration.

The same limit applies to supplied, provider-finalized and continuous server-STT transcripts. Client-STT input remains non-authoritative and non-billable. Session budgets and transport byte limits still apply independently; keep the configured limit within the app capability's input bound. Exceeding it emits `turn.failed` with `voice.transcript_invalid` before calling the brain.

For LiveKit, update the agent and browser `@plumbus/voice-livekit` together: voice events exceeding 15 KiB now use native text streams on `voice.events.large`. Events are delivered in order across streams and ordinary packets. Assembled events are bounded at 256 KiB, with a 30-second read timeout and at most eight active readers. Existing small events keep their packet format.

See [voice definition](./defining-voices.md), [security](./security.md), and [continuous sessions](./livekit-continuous-voice.md).

## Complete-reply delivery

`tts.responseMode: 'reply'` runs the brain once, forwards its visible text deltas, then calls `resolveTone` with `assistantText` and the original `brainResult`. It synthesizes the complete reply in one request after `preprocessForTts`; no sentence rewriting or extra model call is performed. Omitted or `'sentence'` retains the existing streaming sentence pipeline. Complete replies give a provider more prosodic context but delay first audio until the brain finishes. Provider text limits still apply. Aborting before synthesis prevents speech.

`VoiceBrainRunArgs.transcriptConfidence` carries the STT confidence when available. It is a signal for an application's contextual decision, not an automatic classification.

See [continuous-session recovery](./livekit-continuous-voice.md).

## Server-resolved recognition context

`defineVoice.resolveSttContext(ctx, { sessionId, input, language })` can return `{ general, terms, text }` before a server STT connection. The application must authorize the session/project and choose source-backed hints using `ctx.*`; the framework never infers their meaning. The controller resolves the hook once per connection, serializes overlapping connection attempts and passes the result to `STTProviderConnectArgs.context`. Supplied-transcript turns do not reconnect or rerun the hook.

The schema caps context at 8,000 serialized characters, 10 general entries, 100 terms of up to 160 characters and 4,000 free-text characters. Hook/validation errors propagate before the provider connects. No context is accepted directly from client transcript text. Soniox forwards this context to its native configuration; a session context replaces static `contextTerms`. Providers without context support can ignore the optional field. This is recognition guidance, never output word replacement.

Dvora's consumer verification uses Soniox `stt-rt-v5` (confirmed current in the [model catalog](https://soniox.com/docs/stt/models)). Deepdub `dd-etts-3.3` is now the catalog/default TTS model after successful authenticated same-voice synthesis; 3.2 and 3.0 remain explicit compatibility choices. Deepdub's public model documentation lags the live service. Contract-driven generated-audio pricing and speaker selection are unchanged.
