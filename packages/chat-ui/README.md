# @plumbus/chat-ui

React hooks and components for the `@plumbus/chat` SSE turn protocol.

## Install

Peers: `@plumbus/chat` `0.1.x`, `react` / `react-dom` (provided by `@plumbus/ui` in Plumbus apps).

## Usage

```tsx
import { ChatPanel } from '@plumbus/chat-ui';

<ChatPanel
  chatName="help"
  sessionId={sessionId}
  audience="user"
  locale="en"
  turnUrl="/api/chat/help/turn"
/>
```

## Docs

See [`docs/chat/`](../../docs/chat/) in the monorepo for the full framework documentation. UI-specific notes are in [`docs/chat/README.md`](../../docs/chat/README.md) under the chat-ui section.

## Testing

```bash
pnpm test
```
