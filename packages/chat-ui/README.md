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

UI-specific reference lives in [`docs/chat-ui/`](../../docs/chat-ui/) — surface map, `<ChatPanel />` props, the `useChat` return shape, and headless usage. The server-side chat framework is documented in [`docs/chat/`](../../docs/chat/).

## Testing

```bash
pnpm test
```
