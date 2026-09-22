# Upgrading to Voice Provider Packages (0.4.0)

This guide covers migrating from `@plumbus/voice@0.3.x` (vendors bundled) to `@plumbus/voice@0.4.x` (cloud/vendor providers as separate add-on packages that **extend** voice via explicit registration).

## Agent checklist (do this in order)

Use this when upgrading a Plumbus app that uses voice. **Do not stop after `pnpm add`.** Install alone does nothing.

1. **Inventory** — Find every `defineVoice` and note `transport.provider`, `stt.provider`, `tts.provider`. Any of `livekit` / `openai-whisper` / `openai-realtime` / `openai` / `soniox` / `deepdub` / `elevenlabs` / `minimax` needs an add-on.
2. **Install add-ons** — Only the packages for providers the app actually uses (see Install below).
3. **Register** — Build a registry with each package’s `*_REGISTRATION` via `createProviderRegistry({ stt/tts/transport })` and pass `{ registry }` into `registerVoiceRoutes` / workers. Default `createProviderRegistry()` is builtins only (`websocket`, `web-speech`, `browser-tts`). Each registration’s `pricing` field is auto-seeded into `lookupVoicePricing` so STT/TTS ledger USD is non-null (do not leave Soniox/Deepdub rows at `$0` with real usage).
4. **Export for CLI/workers** — Create `app/voice/registry.ts` that exports `voiceProviderRegistry` (and optionally `voiceProviders` for credentials). `plumbus voice worker` loads this file; there is no soft auto-load of installed packages.
5. **Fix imports** — Move LiveKit symbols off `@plumbus/voice` / `@plumbus/voice/client` (table below). Grep for `createLiveKitVoiceSession`, `startVoiceAgentWorker`, `joinVoiceRoomSession`, `createVoiceAgentEntry`, `parseLiveKitVoiceDataPayload`, `ConnectLiveKitWorkerArgs`. Move OpenAI symbols (`resolveVoiceOpenAICredentials`, OpenAI registrations) to `@plumbus/voice-openai`. Browser clients that need `PlumbusError` / noise-cancellation enums must use `@plumbus/core/errors` and `@plumbus/voice/noise-cancellation` — never the package roots (roots pull CLI/server into Next/Turbopack).
6. **Rename session hook** — `beforeSession.livekit` → `beforeSession.room` (same fields).
7. **Validate** — Run typecheck/tests. Missing registration fails with `voice.provider_package_missing` + `metadata.installPackage` — fix by installing **and** registering, never by inventing a local adapter.
8. **Do not** look for `loadVoiceAddons()`, `createRegistryForVoices()`, `VOICE_ADDON_PACKAGES`, `resolveAddonCredentialsFromEnv()`, optional peers on `@plumbus/voice`, soft “import if installed” worker add-on discovery, or “auto-register when installed.” Those paths do not exist in 0.4.0.

## What changed and why

Heavy vendor SDKs (LiveKit, OpenAI voice adapters, Deepdub, Soniox, ElevenLabs, MiniMax) no longer ship inside `@plumbus/voice`. Install only the add-ons you use. `@plumbus/voice` keeps builtins: **`websocket`**, **`web-speech`**, and **`browser-tts` only**.

**This is a breaking release.** Default `createProviderRegistry()` does **not** include cloud/LiveKit/OpenAI providers. Apps must:

1. Install the add-on package(s)
2. Pass each package’s `*_REGISTRATION` into `createProviderRegistry(...)`
3. Pass that registry to `registerVoiceRoutes` / workers
4. For CLI/workers, export the registry from `app/voice/registry.ts`

## Install

```bash
pnpm add @plumbus/voice-openai     # openai-whisper / openai-realtime STT + openai TTS
pnpm add @plumbus/voice-livekit    # LiveKit transport + agent worker + browser session
pnpm add @plumbus/voice-soniox     # Soniox STT (+ optional Soniox TTS)
pnpm add @plumbus/voice-deepdub    # Deepdub TTS
pnpm add @plumbus/voice-elevenlabs # ElevenLabs TTS
pnpm add @plumbus/voice-minimax    # MiniMax TTS
```

## Register providers (required)

```ts
import { createProviderRegistry, registerVoiceRoutes } from '@plumbus/voice';
import {
  OPENAI_TTS_REGISTRATION,
  OPENAI_WHISPER_STT_REGISTRATION,
} from '@plumbus/voice-openai';
import { LIVEKIT_TRANSPORT_REGISTRATION } from '@plumbus/voice-livekit';
import { SONIOX_STT_REGISTRATION, SONIOX_TTS_REGISTRATION } from '@plumbus/voice-soniox';
import { DEEPDUB_TTS_REGISTRATION } from '@plumbus/voice-deepdub';

export const voiceProviderRegistry = createProviderRegistry({
  stt: {
    'openai-whisper': OPENAI_WHISPER_STT_REGISTRATION,
    soniox: SONIOX_STT_REGISTRATION,
  },
  tts: {
    openai: OPENAI_TTS_REGISTRATION,
    soniox: SONIOX_TTS_REGISTRATION,
    deepdub: DEEPDUB_TTS_REGISTRATION,
  },
  transport: { livekit: LIVEKIT_TRANSPORT_REGISTRATION },
});

registerVoiceRoutes(app, routeConfig, voices, {
  providers,
  registry: voiceProviderRegistry,
});
```

If a voice references an unregistered add-on id, the factory / validation path fails with `voice.provider_package_missing` and `PlumbusError.metadata.installPackage`.

## `app/voice/registry.ts` (CLI / workers)

`plumbus voice worker` and related CLI paths call `loadAppVoiceRegistry()` and **exit** if the file is missing. Export:

```ts
// app/voice/registry.ts
import { createProviderRegistry } from '@plumbus/voice';
import { LIVEKIT_TRANSPORT_REGISTRATION } from '@plumbus/voice-livekit';
import {
  OPENAI_TTS_REGISTRATION,
  OPENAI_WHISPER_STT_REGISTRATION,
} from '@plumbus/voice-openai';

export const voiceProviderRegistry = createProviderRegistry({
  stt: { 'openai-whisper': OPENAI_WHISPER_STT_REGISTRATION },
  tts: { openai: OPENAI_TTS_REGISTRATION },
  transport: { livekit: LIVEKIT_TRANSPORT_REGISTRATION },
});

// optional — credentials for the CLI/worker merge
export const voiceProviders = {
  providers: {
    livekit: {
      url: process.env['LIVEKIT_URL'],
      apiKey: process.env['LIVEKIT_API_KEY'],
      apiSecret: process.env['LIVEKIT_API_SECRET'],
    },
    'openai-whisper': { apiKey: process.env['OPENAI_API_KEY'] },
    openai: { apiKey: process.env['OPENAI_API_KEY'] },
  },
};
```

Accepted export names: `voiceProviderRegistry` or `registry`; `voiceProviders` or `providers`.

## LiveKit import moves

| Symbol | Before | After |
|---|---|---|
| `createLiveKitVoiceSession` / `applyClientNoiseCancellation` / `parseLiveKitVoiceDataPayload` / agent track+PCM helpers | `@plumbus/voice/client` | `@plumbus/voice-livekit/client` |
| `createVoiceAgentEntry`, `createInboundAudioStream`, `resolveAgentNoiseCancellationOption` | `@plumbus/voice` | `@plumbus/voice-livekit` |
| `startVoiceAgentWorker`, `joinVoiceRoomSession`, `startVoiceWorker`, `mintLiveKitParticipantToken`, bootstrap helpers | `@plumbus/voice` | `@plumbus/voice-livekit` |
| LiveKit worker/session types (`ConnectLiveKitWorkerArgs`, `StartVoiceAgentWorkerOptions`, …) | `@plumbus/voice` / provider-kit | `@plumbus/voice-livekit` |
| `LIVEKIT_TRANSPORT_DESCRIPTOR`, `recordLiveKitTransportCost`, `parseLiveKitParticipantContext`, `buildBrainInputFromParticipantContext` | `@plumbus/voice` / provider-kit | `@plumbus/voice-livekit` |
| OpenAI Whisper / Realtime STT / OpenAI TTS registrations + `resolveVoiceOpenAICredentials` | `@plumbus/voice` | `@plumbus/voice-openai` |
| Cloud/vendor descriptors, static models, pricing (`SONIOX_*`, `DEEPDUB_*`, `ELEVENLABS_*`, `MINIMAX_*`) | `@plumbus/voice/provider-kit` | matching `@plumbus/voice-*` package |
| `plumbus voice worker` | used `@plumbus/voice` LiveKit helpers | dynamically imports `@plumbus/voice-livekit` and loads `app/voice/registry.ts` via `loadAppVoiceRegistry()` |

## Transport-agnostic `/token`

`POST /api/voice/:name/token` is no longer LiveKit-gated. Any registered transport that implements `mintSession` (and preferably `toClientSessionPayload` on its registration) can serve room tokens. Websocket continues to use `/session`.

`beforeSession` room mint options moved:

```ts
// before (0.3.x / early 0.4 drafts)
beforeSession: async () => ({
  livekit: { roomName: sessionId, metadata: { ... } },
  execution: { userId, tenantId },
});

// after
beforeSession: async () => ({
  room: { roomName: sessionId, metadata: { ... } },
  execution: { userId, tenantId },
});
```

## ElevenLabs behavior note

`@plumbus/voice-elevenlabs` uses the official `@elevenlabs/elevenlabs-js` SDK (`textToSpeech.stream`) for both v3 and flash. The previous untested WebSocket flash path was removed.

`@plumbus/voice-openai` uses the official [`openai`](https://www.npmjs.com/package/openai) SDK for Whisper STT, TTS, and Realtime STT (`OpenAIRealtimeWS`). Apps must not import `openai` / `ws` — keep `baseUrl` / `OPENAI_BASE_URL` overrides on credentials. Realtime connection model defaults to `gpt-realtime` (`stt.options.realtimeConnectionModel`); transcription model remains `stt.model`.

## Dependency direction

Add-ons peer-depend on `@plumbus/voice` `0.4.x` and `@plumbus/core` `0.6.x` (copy those literals). `@plumbus/voice` does **not** peer-depend on the add-ons.

## Voice cloning (0.4.3 / add-on 0.1.2)

`@plumbus/voice` `0.4.3+` adds `createVoiceCloneProvider`, `synthesizeWithVoiceReference`, and `registerVoiceCloneRoutes`. Register Deepdub/Soniox TTS as usual — clone factories live on `*_TTS_REGISTRATION.clone`.

- **Deepdub** `@plumbus/voice-deepdub` `0.1.2` — `@deepdub/node` `^3.0.2`; create via SDK `addVoice`; get/delete via REST.
- **Soniox** `@plumbus/voice-soniox` `0.1.2` — requires `@soniox/node` `^2.2.0` for `client.tts.voices.*`. After upgrade, reinstall the add-on so the SDK bump lands.

Ownership-aware HTTP, rollback, and preview vs long-form guidance: [voice/voice-cloning.md](./voice/voice-cloning.md).
