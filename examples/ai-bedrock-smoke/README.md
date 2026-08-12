# ai-bedrock-smoke

Live smoke for Amazon Bedrock from this monorepo. **No fake model responses.**

Two modes (auto-detected from `.env`):

| Mode | Env | What it tests |
|------|-----|----------------|
| **mantle** | `OPENAI_API_KEY` + `OPENAI_BASE_URL=https://bedrock-mantle.<region>.api.aws/v1` | Core `createOpenAIAdapter` against Bedrock Mantle (console “OpenAI compatible” export) |
| **runtime** | `AI_BEDROCK_REGION` + IAM AWS keys | **`@plumbus/ai-bedrock`** Converse / ConverseStream / Titan embed + package cost |

**Important:** A console Bedrock API key exported as `OPENAI_API_KEY` is **Mantle mode**. It does **not** authenticate `@plumbus/ai-bedrock` (that package uses the AWS SDK + IAM against Bedrock Runtime / Converse).

## Prerequisites

```bash
pnpm --filter @plumbus/core --filter @plumbus/ai-bedrock build
```

## Setup (Mantle — matches AWS console export)

```bash
cd examples/ai-bedrock-smoke
cp .env.example .env
```

Put **only in `.env`** (gitignored), do not paste into git/chat long-term:

```bash
OPENAI_API_KEY=bedrock-api-key-…
OPENAI_BASE_URL=https://bedrock-mantle.eu-north-1.api.aws/v1
# optional:
# AI_BEDROCK_MODEL=…          # must be enabled in console
# AI_BEDROCK_EMBEDDING_MODEL=…
```

## Run

```bash
node smoke.mjs
```

Checks: `listModels` → `complete` → `stream` → `embed`.  
Mantle mode asserts **usage**, not Bedrock package `cost > 0` (core `MODEL_PRICING` does not know Bedrock family rates).  
Runtime mode asserts **cost > 0** via `lib/pricing.fixture.json`.

## Security

- Never commit `.env`.
- Prefer short-lived keys; **rotate/delete** after the smoke (especially if the key was pasted into chat).
- This app never prints full secrets (masked prefix/suffix only).
- The agent / CI should not ingest your keys — you paste into local `.env` yourself.

## Runtime mode (`@plumbus/ai-bedrock`)

Clear Mantle vars (or `BEDROCK_SMOKE_MODE=runtime`) and set:

```bash
AI_BEDROCK_REGION=us-east-1
AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…
```

## Troubleshooting

- **Wrong mode** — if both Mantle and IAM vars are set, Mantle wins when the base URL is `bedrock-mantle.*`. Force with `BEDROCK_SMOKE_MODE=runtime|mantle`.
- **Model not found** — enable the model in Bedrock for that region; or set `AI_BEDROCK_MODEL` to an id from the printed `listModels` line.
- **401** — key expired or wrong; create a new Bedrock API key in the console.
