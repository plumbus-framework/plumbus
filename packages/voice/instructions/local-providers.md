# Local / Offline Voice — Agent Recipe

Read this when the user asks for self-hosted, offline-ish, or browser-native voice.

## Preferred local paths

### 1. Whisper-compatible sidecar

If the user wants local/server STT, start with:

```ts
stt: { provider: 'openai-whisper' }
```

and point its credentials at a local or self-hosted endpoint via `baseUrl`.

This is the preferred path for Whisper-compatible APIs because:

- Plumbus already has the adapter
- the credential/config shape is stable
- you do not need a custom adapter just to change the host

### 2. Browser TTS

If the user wants local/client TTS, start with:

```ts
tts: { provider: 'browser-tts' }
```

Use it when the audio should stay in the browser and the app can accept client-managed voices/quality.

## Default recommendations

| Goal | Suggested stack |
|---|---|
| No vendor keys, demo/prototype | `websocket` + `web-speech` + `browser-tts` |
| Self-hosted STT, browser playback | `websocket` + `openai-whisper` (`baseUrl`) + `browser-tts` |
| Self-hosted-ish STT, cloud TTS | `websocket` + `openai-whisper` (`baseUrl`) + chosen cloud TTS |

## Do's

- **Do** reuse `openai-whisper` with `baseUrl` for Whisper-compatible sidecars.
- **Do** document what is client-executed vs server-executed.
- **Do** keep the initial stack simple; only add a custom adapter if the wire protocol is actually different.

## Don'ts

- **Don't** invent a new provider id for a local Whisper clone.
- **Don't** overbuild a fake "local transport" layer when raw websocket already fits the use case.
- **Don't** promise true offline behavior if the chosen stack still depends on a remote app server.

## Deeper reference

- `/docs/voice/local-providers.md`
- `/docs/voice/providers.md`
