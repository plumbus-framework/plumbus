# Client-side STT (`web-speech`)

`web-speech` is the browser-side STT path in `@plumbus/voice`. The browser performs recognition locally or via the browser vendor's speech stack, then relays transcript text to the server over the voice websocket/control channel.

That is fundamentally different from server STT providers like Soniox or Whisper-compatible APIs: the server is not receiving authoritative transcription events from a provider it controls. It is receiving client-originated text.

## Architecture

```
browser microphone
      │
      ▼
SpeechRecognition / Web Speech API
      │
      ▼
`stt.final` control frame over websocket
      │
      ▼
voice runtime (`source: 'client-stt'`)
      │
      ▼
brain.run(ctx, { transcript, ... })
```

The browser still uses the same voice session bootstrap as server STT:

1. `POST /api/voice/:name/session`
2. receive `wsUrl` + short-lived `sessionToken`
3. open websocket using `Sec-WebSocket-Protocol: voice-session.<token>`
4. send `stt.final` and `ptt.up`

## Trust boundary

`web-speech` transcript text is **untrusted input**. Treat it the same way you would treat a form field or chat message typed by the browser:

- tag the provenance as `source: 'client-stt'`
- apply length/rate/content guards
- never use it as authoritative billing evidence
- never assume the browser transcript exactly matches the spoken audio

Production implication: if the app needs auditable STT, billing, or compliance evidence, use a server STT provider.

## Browser support

The package intentionally does **not** promise consistent behavior across browsers. Availability, locale coverage, permissions UX, and continuous-recognition behavior vary by browser/platform.

Use `web-speech` when:

- the product can tolerate browser variability
- the fastest path is more important than transcript authority
- you want a zero-vendor-key prototype

Prefer server STT when:

- you need predictable locale support
- the app records/transacts on transcripts
- the app needs provider-owned telemetry or billing

## Common pairing patterns

| Goal | Suggested stack |
|---|---|
| Fastest browser demo | `websocket` + `web-speech` + `browser-tts` |
| Browser STT, server TTS | `websocket` + `web-speech` + cloud TTS provider |
| Production-grade transcript authority | use a server STT provider instead |

## Mistakes to avoid

- Returning provider secrets to the browser to simulate "server STT"
- Billing `web-speech` transcript text as `transcribe`
- Treating `web-speech` as if it were a server-owned websocket STT stream
- Omitting the origin check because "the browser is already trusted"

## Related docs

- [security.md](./security.md)
- [transports.md](./transports.md)
- [testing.md](./testing.md)
