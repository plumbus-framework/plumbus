# Wiring `web-speech` — Agent Recipe

Read this before choosing `stt: { provider: 'web-speech' }`.

## What `web-speech` means

`web-speech` is **browser-side STT**. The browser listens to the microphone, performs speech recognition, and relays transcript text to the server over the voice websocket/event protocol.

That means:

- the server is receiving **text**, not authoritative provider-side transcription
- the transcript provenance is `source: 'client-stt'`
- the transcript is **not billable STT usage**
- the browser compatibility story is outside Plumbus control

## Use it when

- the user wants the lightest browser-first voice prototype
- there are no vendor STT keys yet
- transcript trust is advisory, not billing-critical

## Do not use it when

- the app needs authoritative billing or retention
- you need server-owned STT quality guarantees
- you are building an auditable call/compliance flow

In those cases, prefer a server STT provider.

## Wire protocol expectations

The browser websocket/control flow is:

1. server mints a short-lived `sessionToken`
2. browser opens the websocket with `Sec-WebSocket-Protocol: voice-session.<token>`
3. browser sends `stt.final` control frames with transcript text
4. browser sends `ptt.up` to trigger a turn
5. server streams `tts.speak`, audio chunks, `turn.completed`, and state events

## Do's

- **Do** send the session token in `Sec-WebSocket-Protocol` rather than the URL query string.
- **Do** tag the transcript as client-derived and run the normal safety/content guards.
- **Do** keep the browser responsible for microphone permission prompts and recognition lifecycle.
- **Do** pair `web-speech` with `browser-tts` for the simplest fully local browser stack when that is what the user asked for.

## Don'ts

- **Don't** bill `web-speech` transcript text as STT usage.
- **Don't** treat the transcript as authoritative evidence of what was spoken.
- **Don't** leak API keys to the browser just to fake a server-side STT flow.
- **Don't** promise uniform browser support. State clearly that support varies by browser/platform.

## Deeper reference

- `/docs/voice/client-stt.md`
- `/docs/voice/security.md`
