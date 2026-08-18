# Extending `@plumbus/voice` — Agent Recipe

Use this when the built-ins are not enough.

## Supported extension points

- `createProviderRegistry(...)` for custom STT/TTS/transport registrations
- `toneProfiles` + `resolveTone(...)` for delivery-style selection (`DeliveryTone.voiceId` / `targetGender` are per-turn overrides; adapters map them)
- `preprocessForTts(...)` for last-mile TTS text shaping
- `runVoiceTurn(...)` for composing a custom transport or worker wrapper

## Preferred order

1. Reuse a built-in provider with different credentials/config.
2. Install the official add-on (`@plumbus/voice-livekit`, `-soniox`, `-deepdub`, `-elevenlabs`, `-minimax`) if the vendor already has one.
3. Add a light custom registration through `createProviderRegistry`.
4. Only then change runtime orchestration.

## Authoring a provider adapter

Import shared contract types and kit helpers from the **`@plumbus/voice/provider-kit`** subpath — never from deep `@plumbus/voice/dist/...` paths. Vendor descriptors, static models, and pricing constants live in each `@plumbus/voice-*` add-on (not provider-kit).

```ts
import {
  LIVEKIT_TRANSPORT_DESCRIPTOR,
  recordLiveKitTransportCost,
} from '@plumbus/voice-livekit';
```

LiveKit worker/session contracts (`ConnectLiveKitWorkerArgs`, `StartVoiceAgentWorkerOptions`, …) also live on `@plumbus/voice-livekit`.

For a new vendor that carries its own SDK, publish a separate package (`@plumbus/voice-<vendor>` shape) that peer-depends on `@plumbus/voice` and exports a `*_REGISTRATION`. That keeps the vendor SDK out of every `@plumbus/voice` install — the reason the cloud providers were extracted in 0.4.0.

## Rules

- **Do** keep provider-specific mapping inside the provider adapter (`mapDeliveryTone`), not in app code.
- **Do** preserve the event contract (`session.hello`, `agent.state`, `tts.speak`, `turn.completed`, `error`).
- **Do** keep business logic in `brain.run`, not in provider classes.
- **Don't** fork `registerVoiceRoutes()` unless the user explicitly needs a non-standard transport.
- **Don't** hand-roll an adapter for a vendor that already ships a `@plumbus/voice-*` package — install it instead.

## Deeper reference

- `/docs/voice/design/providers.md`
- `/docs/voice/providers.md`
- `/docs/upgrading-voice-provider-packages.md`
