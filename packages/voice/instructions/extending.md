# Extending `@plumbus/voice` — Agent Recipe

Use this when the built-ins are not enough.

## Supported extension points

- `createProviderRegistry(...)` for custom STT/TTS/transport registrations
- `toneProfiles` + `resolveTone(...)` for delivery-style selection
- `preprocessForTts(...)` for last-mile TTS text shaping
- `runVoiceTurn(...)` for composing a custom transport or worker wrapper

## Preferred order

1. Reuse a built-in provider with different credentials/config.
2. Add a light custom registration through `createProviderRegistry`.
3. Only then change runtime orchestration.

## Rules

- **Do** keep provider-specific mapping inside the provider adapter (`mapDeliveryTone`), not in app code.
- **Do** preserve the event contract (`session.hello`, `agent.state`, `tts.speak`, `turn.completed`, `error`).
- **Do** keep business logic in `brain.run`, not in provider classes.
- **Don't** fork `registerVoiceRoutes()` unless the user explicitly needs a non-standard transport.

## Deeper reference

- `/docs/voice/design/providers.md`
- `/docs/voice/providers.md`
