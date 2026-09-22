# Continuous Voice Sessions — Agent Recipe

Use this when the user asks for always-listening / LiveKit + server-STT voice, or reports dropped talk-over, a doubled live transcript, a delayed first TTS sentence, or wants mid-turn “mm-hmm” continuers.

**Exact path in a consumer app:** `node_modules/@plumbus/voice/instructions/continuous-sessions.md`

Concept doc (monorepo): `/docs/voice/livekit-continuous-voice.md`.

## What the runtime already does

Do **not** reimplement these. Do **not** add a parallel timer, phrase pool, or local STT stitcher.

1. **Talk-over-reply is kept** (server-STT continuous only). An utterance that ends while a brain turn or hearing-repair prompt is still in flight is queued and replayed through the normal grace window when that work settles. It becomes the next turn. The web-speech client path still drops a final that arrives during a turn — do not “fix” that by copying the server-STT re-queue into the browser.
2. **Emitted `stt.partial` / `stt.final` carry stitched text** when a grace-window or in-flight fragment is prefixed onto resumed speech. Client transcript UIs must **replace** the current line. Appending fragments double-prints.
3. **Streaming TTS merges micro-fragments.** The turn pipeline always holds chunks shorter than 8 characters and synthesizes them with the following sentence. A written hesitation (`המממ...`) or a short first sentence (`כן.`, `Yes.`) waits for the next sentence. That delay is intended. There is **no** `defineVoice` / `tts.options` knob. `minChunkChars` exists only on the internal `createSentenceChunker()` helper (tests). Do not add it to app config.
4. **Backchannel continuers are opt-in.** Set `stt.options.backchannelEnabled: true` to speak a short audio-only phrase from `backchannelPhrases` after a reflective pause (speech energy + pending transcript, no brain turn, no `assistant.delta`, no `Playing`). Do **not** write a second TTS helper for “mm-hmm”. Isolated one-syllable particles can be mangled by providers — put multi-character phrases in the pool.

Barge-in still discards speech queued before the interrupt. Speech after barge-in still becomes the next turn. Replay never starts after `dispose()` or transport loss.

## Knobs that exist

| Option | Where | Role |
|---|---|---|
| `stt.options.endpointGraceMs` | `defineVoice` | Defer the turn after endpoint so a resume stitches onto the deferred utterance (default `0`) |
| `stt.options.endpointSilenceMs` | `defineVoice` | Silence-timer failsafe for providers **without** `capabilities.endpointDetection` (default 4000). Soniox does not use this unless you force a positive value |
| `stt.options.endpointSensitivity` | Soniox | How eagerly the provider emits `<end>` (`-1`..`1`, default `0`) |
| `stt.options.languageHintsStrict` | Soniox | Override the single-language `language_hints_strict` default. See `@plumbus/voice-soniox` |
| `stt.options.contextTerms` | Soniox | Domain vocabulary (`context.terms`) |
| `stt.options.enableInputNormalization` | `defineVoice` | Gain the mic toward `targetRmsDb` before STT |
| `stt.options.backchannelEnabled` | `defineVoice` | Opt-in continuers during a reflective pause (default `false`) |
| `stt.options.backchannelPauseMs` | `defineVoice` | Silence after last speech-energy chunk before a continuer (default `900`) |
| `stt.options.backchannelMinTranscriptChars` | `defineVoice` | Minimum pending transcript length (default `40`) |
| `stt.options.backchannelCooldownMs` | `defineVoice` | Minimum gap between continuers (default `6000`) |
| `stt.options.backchannelPhrases` | `defineVoice` | Flat `string[]` or `{ he, en, default }` map. Default pool is `['mm-hm']` |
| `DeliveryTone.voiceId` / `targetGender` | `toneProfiles` / `resolveTone` | Per-turn voice / gender; Deepdub maps `voiceId` over static `tts.voiceId` |

## Knobs that do not exist

- `minChunkChars` / `tts.options.minChunkChars` — not a voice setting
- A public “re-queue off” switch — talk-over-reply staying queued is the product behavior

## Don'ts

- **Don't** append `stt.partial` fragments in the UI.
- **Don't** invent a local backchannel or “listening noise” TTS helper — use `backchannelEnabled` and `backchannelPhrases`.
- **Don't** split the sentence chunker to make `כן.` speak immediately.
- **Don't** treat talk-over-reply as lost and add a second brain trigger.
- **Don't** import `@plumbus/voice` internals (`src/runtime/sentence-chunker.ts`) from an app.

## Related recipes

| Task | Read |
|---|---|
| `defineVoice` + routes | [`defining-voices.md`](./defining-voices.md) |
| LiveKit browser session | `node_modules/@plumbus/voice-livekit/instructions/client-session.md` |
| LiveKit worker | `node_modules/@plumbus/voice-livekit/instructions/agent-worker.md` |
| Soniox hints / strict mode | `node_modules/@plumbus/voice-soniox/instructions/framework.md` |
