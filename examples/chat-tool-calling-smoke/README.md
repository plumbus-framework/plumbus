# chat-tool-calling-smoke

A tiny, runnable smoke test for **`@plumbus/chat` provider-native tool calling (Path B)**
against any **OpenAI-compatible** server (Ollama, Open WebUI, OpenAI, …).

It sends one chat turn ("what is the weather in Helsinki?") to a chat that allowlists a
read-only `getWeather` tool, and prints the event stream so you can see the model select
the tool, the runtime execute it, and the final answer come back.

It runs **entirely in-memory** — no Postgres, no server, no build for this app. It imports
the already-built `dist/` of `@plumbus/core` and `@plumbus/chat` directly.

## What it exercises

One `runChatTurn` in Path B:

1. **scope preflight** (`chat.scopeCheck`) — is the turn in scope?
2. **tool phase** (`chat.toolRound`) — the model is offered `getWeather` as a native tool;
   if it calls it, the runtime runs the capability via `executeCapability` (deny-by-default
   access still applies) and feeds the result back.
3. **answer phase** (`chat.turn`) — a final structured answer.

`getWeather` is a **read-only** capability (all effect arrays empty ⇒ `auto` mode), so
nothing needs user confirmation and no conversation store / database is touched.

## Prerequisites

- Node 20+ (uses `process.loadEnvFile` and global `fetch`).
- The framework packages built once from the repo root:
  ```bash
  pnpm --filter @plumbus/core --filter @plumbus/chat build
  # or: pnpm build
  ```
- An OpenAI-compatible server reachable from this host, serving a model that supports
  **native tool calling** (e.g. `qwen2.5`, `llama3.1`, `mistral-nemo`).

## Setup

```bash
cd examples/chat-tool-calling-smoke
cp .env.example .env      # then edit .env
```

Set all three required values in `.env` (there are **no code defaults**):

| Var | Meaning |
|---|---|
| `PLUMBUS_OPENAI_BASE_URL` | Endpoint; the adapter POSTs to `${BASE_URL}/chat/completions` (include `/v1`). |
| `PLUMBUS_OPENAI_API_KEY`  | `Authorization: Bearer <key>`. Bare Ollama ignores it; OpenAI/Open WebUI need a real one. |
| `PLUMBUS_OPENAI_MODEL`    | A tool-capable model your server exposes. |

Optional: `PLUMBUS_CHAT_MESSAGE` (or pass the message as a CLI arg).

## Run

```bash
node smoke.mjs
# or override the question:
node smoke.mjs "What is the weather in London?"
```

Expected output (model-dependent):

```
· turn.started
· tool.started  getWeather (capability)
· tool.completed getWeather
· turn.completed
────────────────────────────────────────────────────────────────────────
Answer: It's about 3°C and lightly snowing in Helsinki right now.
────────────────────────────────────────────────────────────────────────
tool invoked : yes (getWeather)
turn status  : completed
```

Exit code `0` on a completed turn, `1` on failure.

## Troubleshooting

- **`turn status : completed` but `tool invoked : no`** — the model didn't emit a native
  tool call. Switch `PLUMBUS_OPENAI_MODEL` to a tool-capable model.
- **`turn.failed` with a validation/JSON error** — the scope/answer prompts ask for JSON
  output; pick a model that honors JSON mode.
- **`Could not reach the OpenAI-compatible server`** — `PLUMBUS_OPENAI_BASE_URL` isn't
  reachable from this host, or the server isn't running.
- **`Missing build output …`** — build the framework packages first (see Prerequisites).

## Extending

- Add more read tools: define another `defineCapability` (empty effects) in
  [`lib/app.mjs`](lib/app.mjs) and add its name to `toolCalling.capabilities`.
- Try a **write** capability (non-empty `data`/`events`/`external` effects): it becomes
  `confirm`-mode — the turn pauses with `confirmation_required` and the confirm/execute/
  resume flow needs the conversation store + `POST /chat/:name/confirm` (see
  `docs/chat/tool-calling.md`). That's beyond this in-memory smoke test.
