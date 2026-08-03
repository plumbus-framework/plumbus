# Local / Self-Hosted Voice Providers — Agent Recipe

Use this when the user wants offline, air-gapped, or self-hosted speech stacks.

## Builtins (no add-on)

| Goal | Stack |
|---|---|
| Zero cloud keys | `websocket` + `web-speech` + `browser-tts` |

## Whisper-compatible sidecars

Install `@plumbus/voice-openai` and register `OPENAI_WHISPER_STT_REGISTRATION`. Keep `stt.provider: 'openai-whisper'` and set `baseUrl` on credentials to the sidecar — do **not** invent a parallel adapter.

```ts
stt: { provider: 'openai-whisper' }
// providers.providers['openai-whisper'] = { apiKey: 'local', baseUrl: 'http://localhost:8080/v1' }
```

## Do / don't

- **Do** start with builtins for browser-only prototypes.
- **Do** reuse `@plumbus/voice-openai` + `baseUrl` for Whisper-compatible local endpoints.
- **Don't** invent a new STT adapter just to point at a local Whisper API.
- **Don't** expect OpenAI providers to exist inside `@plumbus/voice` without the add-on package.
