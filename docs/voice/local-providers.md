# Local and Self-hosted Providers

`@plumbus/voice` deliberately keeps the first local/offline story simple:

- reuse `@plumbus/voice-openai` (`openai-whisper`) with a custom `baseUrl` for Whisper-compatible sidecars
- use `browser-tts` when synthesis should happen entirely in the browser

## Self-hosted STT: Whisper-compatible sidecar

If you have a local or self-hosted service that exposes an OpenAI-compatible transcription API, install `@plumbus/voice-openai`, register `OPENAI_WHISPER_STT_REGISTRATION`, keep `stt.provider: 'openai-whisper'`, and override `baseUrl` (passed as the official SDK `baseURL`). Do not invent a parallel adapter.

```ts
import { createProviderRegistry } from '@plumbus/voice';
import { OPENAI_WHISPER_STT_REGISTRATION } from '@plumbus/voice-openai';

const registry = createProviderRegistry({
  stt: { 'openai-whisper': OPENAI_WHISPER_STT_REGISTRATION },
});

// defineVoice({ …, stt: { provider: 'openai-whisper', model: 'whisper-1' } })

const providers = {
  providers: {
    'openai-whisper': {
      apiKey: 'local-dev-placeholder',
      baseUrl: 'http://127.0.0.1:8000/v1',
    },
  },
};
```

This is preferred over adding a new provider because the contract is already compatible: auth shape, endpoint family, and usage semantics are close enough.

## Browser-local TTS

If the user wants "local TTS" in a browser app, `browser-tts` is usually the correct answer:

```ts
tts: {
  provider: 'browser-tts',
  locale: 'en-US',
}
```

That keeps voice output in the browser, avoids server credentials, and pairs naturally with `web-speech`.

## Suggested presets

| Preset | Stack | Best for |
|---|---|---|
| Fully local browser | `websocket` + `web-speech` + `browser-tts` | demos, prototypes, no vendor keys |
| Self-hosted STT + browser playback | `websocket` + `openai-whisper` (`baseUrl`) + `browser-tts` | server-owned transcripts, client-owned synthesis |
| Self-hosted STT + cloud TTS | `websocket` + `openai-whisper` (`baseUrl`) + `openai` (`@plumbus/voice-openai`) or `deepdub`/`minimax` (add-ons) | controlled STT with richer server TTS |

## Sidecar checklist

Before recommending a local Whisper sidecar, verify:

1. it exposes an OpenAI-compatible transcription endpoint
2. the app can reach its `baseUrl`
3. the media format is compatible with the runtime's chosen audio format
4. the deployment model is clear: local dev only, self-hosted prod, or both

## Anti-patterns

- Adding a new provider id for every Whisper clone
- Claiming "offline" when the app still needs a remote server for session minting
- Building a custom TTS adapter when browser speech synthesis already fits the requested scope

## Related docs

- [providers.md](./providers.md)
- [configuration.md](./configuration.md)
