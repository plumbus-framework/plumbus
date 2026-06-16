# Providers

`@plumbus/voice` separates voice infrastructure into three provider kinds:

- **transport** — how a session is established and audio/data move in realtime
- **STT** — how speech becomes text
- **TTS** — how text becomes speech

That lets apps mix stacks deliberately instead of buying into a monolith.

## Built-in adapters

| Kind | Providers | Notes |
|---|---|---|
| Transport | `websocket`, `livekit` | raw app websocket vs managed room/media infra |
| STT | `web-speech`, `soniox`, `openai-whisper`, `openai-realtime` | client STT vs server STT |
| TTS | `browser-tts`, `openai`, `deepdub`, `minimax`, `elevenlabs` | client TTS vs server TTS |

## How to choose

| Decision | Recommendation |
|---|---|
| Need the simplest default | start with `websocket` |
| Already standardized on LiveKit | use `livekit` transport |
| Need browser-only prototype | `web-speech` + `browser-tts` |
| Need authoritative transcripts | use a server STT provider |
| Need better TTS tone control | evaluate `deepdub`, `minimax`, or `elevenlabs` per locale/latency constraints |

## Catalog API

Two catalog entry points power admin tooling:

- `listVoiceProviderCatalog()` — static built-in catalog
- `fetchVoiceProviderOptions(...)` — optional live model/voice discovery with cache fallback

The HTTP layer exposes matching admin routes under `/api/voice/catalog*`.

Typical use:

- setup UI lists all supported providers from the static catalog
- admin drills into a provider to fetch voices/models from the live provider API
- UI stores only the chosen provider/model/voice ids in app config

## Custom provider registration

Use `createProviderRegistry()` when you need to add or override registrations.

```ts
const registry = createProviderRegistry({
  tts: {
    myProvider: {
      descriptor,
      create(credentials, voiceSlice) {
        return new MyTtsProvider(credentials, voiceSlice);
      },
    },
  },
});
```

Keep custom adapters narrow:

- transport owns realtime session mechanics
- STT owns transcript acquisition
- TTS owns tone mapping and synthesis

Do not move app business logic into provider classes.

## Related docs

- [transports.md](./transports.md)
- [design/providers.md](./design/providers.md)
- [local-providers.md](./local-providers.md)
