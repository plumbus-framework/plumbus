# @plumbus/chat-ui — Agent Instructions

This folder ships with the npm tarball. It is the entry point for AI coding agents working in a Plumbus app that has `@plumbus/chat-ui` installed. Read these files when wiring a chat UI, building a custom chat renderer, or implementing the action-confirmation round-trip.

These files are **prescriptive** (do this, don't do that). For deeper conceptual reference (wiring diagram, event vocabulary, persistence pairing matrix), see `docs/chat-ui/README.md` in the Plumbus monorepo.

| File | When to read |
|---|---|
| [framework.md](./framework.md) | First. Package boundary (client-side only), public exports, file map, critical rules. |
| [wiring-chat-panel.md](./wiring-chat-panel.md) | Default path — using `<ChatPanel />` with `useChat` defaults. Covers sessionId, persistence pairing, `turnUrl` override. |
| [custom-ui.md](./custom-ui.md) | When `<ChatPanel />` is not enough — `useChat` headless, the pure helpers, `readChatStream` for non-React clients. |
| [action-confirmation.md](./action-confirmation.md) | The confirm/decline round-trip — how `confirm()`/`decline()` POST to `/chat/:name/confirm` so the server executes the confirmed action and resumes the turn. |

Package quickstart: [../README.md](../README.md).

## Critical rules

- **Client-side only.** `@plumbus/chat-ui` is React 19. Don't import any of its surface from a Node-only context (capabilities, flows, jobs). The hook calls `fetch` with `credentials: 'include'`.
- **`<ChatPanel persistence>` MUST match the server's `defineChat({ persistence: { messageContent } })`.** Mismatch will run but behave badly — server-mode client sends no history (model loses context); client-mode client ships history the server ignores.
- **`useChat.confirm(actionId?)` / `decline(actionId?)` perform a real server round-trip.** They POST `{ actionId, inputSchemaHash, decision }` to `/chat/:name/confirm` (cookie auth + CSRF header), and the server executes the confirmed capability/flow from the stored normalized input, then resumes the turn for a final answer. `cancel()` is the local-only dismiss (no network). See action-confirmation.md.
- **Don't add `react`, `react-dom`, or `next` to a consumer app `package.json`.** They are provided transitively by `@plumbus/ui` in Plumbus apps.
- **Don't reach into `dist/`.** Always import from `@plumbus/chat-ui` (root barrel) — there is no subpath today.
