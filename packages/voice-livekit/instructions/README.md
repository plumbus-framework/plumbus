# @plumbus/voice-livekit — Agent Instructions

**After `pnpm add @plumbus/voice-livekit`, open this file first:**

`node_modules/@plumbus/voice-livekit/instructions/README.md`

Then read the topic file for your task. Do not invent LiveKit wiring from memory.

| File | When to read | Exact consumer path |
|---|---|---|
| [framework.md](./framework.md) | Install, peers, registration, env, exports | `node_modules/@plumbus/voice-livekit/instructions/framework.md` |
| [client-session.md](./client-session.md) | Browser PTT / continuous session | `node_modules/@plumbus/voice-livekit/instructions/client-session.md` |
| [agent-worker.md](./agent-worker.md) | `plumbus voice worker` / agent entry | `node_modules/@plumbus/voice-livekit/instructions/agent-worker.md` |
| [noise-cancellation.md](./noise-cancellation.md) | Krisp / RNNoise / DTLN on LiveKit | `node_modules/@plumbus/voice-livekit/instructions/noise-cancellation.md` |

Parent voice recipes (always install `@plumbus/voice` too):  
`node_modules/@plumbus/voice/instructions/README.md`

Package overview: [../README.md](../README.md). Concept docs: `docs/voice/livekit-continuous-voice.md`.

## Critical rules

- **Install only for `transport.provider: 'livekit'`** — built-in `websocket` stays on `@plumbus/voice`.
- **Register explicitly** — `createProviderRegistry({ transport: { livekit: LIVEKIT_TRANSPORT_REGISTRATION } })` and pass that registry to routes/workers. Install alone does **not** register.
- **Browser** → `@plumbus/voice-livekit/client`. **Worker** → `@plumbus/voice-livekit` or `./worker`.
- **CLI/workers** need `app/voice/registry.ts` exporting `voiceProviderRegistry`.
- **Business logic stays in `brain.run` / capabilities** — this package adapts LiveKit rooms and audio I/O only.
