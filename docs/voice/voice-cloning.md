# Voice Cloning

Persisted voice cloning lets apps upload a short reference clip, receive a vendor `voiceId`, and reuse that id as `tts.voiceId` for long-form synthesis (for example audiobook chapter jobs).

Instant DeepDub `voiceReference` synthesis is a **short-text preview** helper only — HTTP `generateToBuffer` is non-streaming and buffers the full utterance.

## Provider matrix

| Provider | Package | Persist | Instant reference | Delete | Recompute | Readiness |
|---|---|---|---|---|---|---|
| Deepdub | `@plumbus/voice-deepdub` | SDK `addVoice` | HTTP `voiceReference` | REST `DELETE /voice/{id}` | No | Immediate id after upload |
| Soniox | `@plumbus/voice-soniox` | `client.tts.voices.create` | No | SDK delete | Yes | Async per model — poll `waitUntilReady` |

Bump notes: Deepdub uses `@deepdub/node` `^3.0.2` (no SDK get/delete). Soniox requires `@soniox/node` `^2.2.0` for `tts.voices.*`.

**Long-form fit:** Deepdub `dd-etts-*` is generally stronger for multi-hour audiobook synthesis. Soniox cloning is first-class, but `tts-rt-v1` is realtime-oriented.

Soniox treats a UUID `voice` value as a cloned voice and a non-UUID as a built-in name — persisted clone ids work with existing `generateStream` without adapter changes.

## Programmatic API

```ts
import {
  createProviderRegistry,
  createVoiceCloneProvider,
  createTTSProvider,
  synthesizeWithVoiceReference,
} from '@plumbus/voice';
import { DEEPDUB_TTS_REGISTRATION } from '@plumbus/voice-deepdub';
import { SONIOX_TTS_REGISTRATION } from '@plumbus/voice-soniox';

const registry = createProviderRegistry({
  tts: {
    deepdub: DEEPDUB_TTS_REGISTRATION,
    soniox: SONIOX_TTS_REGISTRATION,
  },
});

const clone = createVoiceCloneProvider({
  providerId: 'soniox',
  providers,
  registry,
});

const created = await clone.create({
  name: `user-${userId}`,
  audio: sampleBytes,
  filename: 'sample.wav',
  // Deepdub also requires:
  // gender: 'male' | 'female',
  // locale: 'he-IL',
  // Deepdub optional metadata:
  // speakingStyle: 'Reading',   // match the sample's register (default 'Neutral')
  // text: sampleTranscript,     // transcript of the sample audio
});
const ready = await clone.waitUntilReady(created.id, { model: 'tts-rt-v1' });

// App persists userId → ready.id, then synthesizes chapters:
const tts = createTTSProvider({
  registry,
  providers,
  voiceSlice: {
    provider: 'soniox',
    voiceId: ready.id,
    model: 'tts-rt-v1',
  },
});
for await (const chunk of tts.synthesizeStream!(chapterText, tts.mapDeliveryTone({}))) {
  // write chapter audio
}
```

Deepdub gender is **`male` | `female` only** (mapped to `MALE`/`FEMALE`).

### Preview (Deepdub only)

```ts
const audio = await synthesizeWithVoiceReference({
  providerId: 'deepdub',
  providers,
  registry,
  input: {
    text: 'Short preview line.',
    audio: sampleBytes,
    filename: 'sample.wav',
    locale: 'en-US',
  },
});
```

Any audio can impersonate a speaker — treat this as a spoofing surface (consent, rate limits, stricter access).

## HTTP routes

`registerVoiceCloneRoutes(app, routeConfig, opts)` is separate from `registerVoiceRoutes` (keeps Fastify optional on the core package). Register `@fastify/multipart` on the app before create / synthesize-reference uploads.

Required ownership hooks:

- `access` — who may call clone lifecycle routes
- `resolveCloneOwner` — map vendor `voiceId` → owning `userId` (compared to `auth.userId`)
- `afterCloneCreate` — persist mapping in the same request; on failure the framework **best-effort deletes** the vendor voice
- `listOwnedClones` — `GET /clones` never dumps the shared API-key voice bank

Optional: `referenceAccess` — when set, registers `POST .../synthesize-reference` under that stricter policy.

| Method | Path |
|---|---|
| POST | `/api/voice/providers/:providerId/clones` |
| GET | `/api/voice/providers/:providerId/clones` |
| GET | `/api/voice/providers/:providerId/clones/:id` |
| DELETE | `/api/voice/providers/:providerId/clones/:id` |
| POST | `/api/voice/providers/:providerId/clones/:id/wait` |
| POST | `/api/voice/providers/:providerId/clones/:id/recompute` |
| POST | `/api/voice/providers/:providerId/synthesize-reference` |

Create returns immediately (**no** blocking wait). Clients poll get/wait.

## Security

- Reference audio is sensitive — never log raw samples.
- Clone APIs are server-side only (vendor keys stay on the server).
- Ownership checks on every per-id route; list is app-owned.
- Shared vendor API keys share one voice bank — true tenant isolation needs per-tenant vendor projects/keys.
- `defineVoice().tts.voiceId` is static/frozen; per-user realtime clones need app-level selection. Audiobook jobs use `createTTSProvider({ voiceId })` dynamically.

## Cost

`VoiceUsageKind` includes `'clone'`. Persist create/delete emit `kind: 'clone'` / `unit: 'events'`. Instant-reference uses `'synthesize'` (characters).

## Out of scope

Manuscript chaptering/stitching, MiniMax/ElevenLabs/OpenAI clone-create, browser-held vendor keys, and reworking `runVoiceTurn` / LiveKit for audiobook jobs.
