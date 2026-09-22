# Transports

Transport answers one question: how does a voice session get established and how do audio/data frames move once the session is live?

`@plumbus/voice` ships the `websocket` transport built-in. LiveKit ships as `@plumbus/voice-livekit` — install it and register `LIVEKIT_TRANSPORT_REGISTRATION` with `createProviderRegistry()`.

## `websocket` vs `livekit`

| Concern | `websocket` | `livekit` |
|---|---|---|
| Install | built into `@plumbus/voice` | `pnpm add @plumbus/voice-livekit` |
| Infra footprint | app-owned Fastify + websocket route | external media/session infra |
| Bootstrap | `wsUrl` + short-lived session token | room/url/token grant |
| Best for | simple push-to-talk apps, CI smoke, no vendor dependency | apps already standardized on LiveKit rooms/media |
| Cost model | mostly app/server + optional provider usage | includes transport/session infrastructure spend |
| Security focus | websocket origin, token scoping, raw frame handling | room/participant grant scoping plus app route auth |

## Raw WebSocket

Choose `websocket` when:

- you want the shortest path to production
- you need CI-friendly in-process smoke/e2e coverage
- you do not need room semantics or external media orchestration

The default voice websocket protocol is intentionally small:

- session bootstrap over HTTP
- websocket upgrade with short-lived session token
- control frames like `stt.final`, `ptt.up`, `agent.state`, `tts.speak`
- optional binary audio chunks

Push-to-talk is the default mental model for v1.

## LiveKit

Choose `livekit` when:

- the product already depends on LiveKit
- multi-party or media-room semantics matter
- you want LiveKit's room/grant model more than raw app-owned websocket simplicity

Server workers publish assistant audio as `pcm16;rate=16000;channels=1` on the `agent-voice` track by default (override with `transport.options.agentAudioTrackName`). Browser clients should use `createLiveKitVoiceSession()` from `@plumbus/voice-livekit/client`, which resamples captured agent audio to the same 16 kHz mono PCM format before `onAudioChunk`.

Push-to-talk over LiveKit uses reliable data messages (`ptt.down` / `ptt.up`) via `session.ptt` on the client helper or raw `publishData` control frames on custom clients.

### Noise cancellation

Configure `transport.options.noiseCancellation` on the voice definition. Plumbus supports **client** or **agent** placement (never both): Krisp (`@livekit/krisp-noise-filter` / `@livekit/noise-cancellation-node`) and OSS RNNoise/DTLN. LiveKit token responses include the serialized config for browser auto-wiring. See [noise-cancellation.md](./noise-cancellation.md) and [`packages/voice/instructions/noise-cancellation.md`](../../packages/voice/instructions/noise-cancellation.md).

Security note: LiveKit token signing uses LiveKit credentials, **not** the app auth secret.

## Picking the default

If you are unsure, start with `websocket`. It keeps the system easy to reason about, easy to test in CI, and aligns with the package's smoke/e2e strategy.

## Related docs

- [providers.md](./providers.md)
- [security.md](./security.md)
- [testing.md](./testing.md)
