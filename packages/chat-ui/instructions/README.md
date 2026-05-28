# @plumbus/chat-ui — Agent Instructions

This folder ships with the npm tarball. It is the entry point for AI coding agents working in a Plumbus app that has `@plumbus/chat-ui` installed. Read these files when wiring a chat UI, building a custom chat renderer, or implementing the action-confirmation round-trip.

These files are **prescriptive** (do this, don't do that). For deeper conceptual reference (wiring diagram, event vocabulary, persistence pairing matrix), see `docs/chat-ui/README.md` in the Plumbus monorepo.

| File | When to read |
|---|---|
| [framework.md](./framework.md) | First. Package boundary (client-side only), public exports, file map, critical rules. |
| [wiring-chat-panel.md](./wiring-chat-panel.md) | Default path — using `<ChatPanel />` with `useChat` defaults. Covers sessionId, persistence pairing, `turnUrl` override. |
| [custom-ui.md](./custom-ui.md) | When `<ChatPanel />` is not enough — `useChat` headless, the pure helpers, `readChatStream` for non-React clients. |
| [action-confirmation.md](./action-confirmation.md) | The confirm() gap — apps that ship action-confirmation flows must call `chatConfirmAction` directly. |

Package quickstart: [../README.md](../README.md).

## Critical rules

- **Client-side only.** `@plumbus/chat-ui` is React 19. Don't import any of its surface from a Node-only context (capabilities, flows, jobs). The hook calls `fetch` with `credentials: 'include'`.
- **`<ChatPanel persistence>` MUST match the server's `defineChat({ persistence: { messageContent } })`.** Mismatch will run but behave badly — server-mode client sends no history (model loses context); client-mode client ships history the server ignores.
- **`useChat.confirm(actionId)` is a UI-only stub.** It clears local `pendingConfirmation` state and does NOT call the server. Apps that ship action confirmation MUST call `chatConfirmAction` directly with `{ actionId, capabilityName, schemaHash, execute }` — see action-confirmation.md.
- **Don't add `react`, `react-dom`, or `next` to a consumer app `package.json`.** They are provided transitively by `@plumbus/ui` in Plumbus apps.
- **Don't reach into `dist/`.** Always import from `@plumbus/chat-ui` (root barrel) — there is no subpath today.
