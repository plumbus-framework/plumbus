# Bedrock pricing — pull, normalize, mount

**Exact path in a consumer app:** `node_modules/@plumbus/ai-bedrock/instructions/pricing.md`

Prescriptive recipe for operators and agents. Read this before wiring `AI_BEDROCK_PRICING_FILE` or debugging `$0` costs.

## 60-second answer

1. Bedrock APIs return **tokens only** — never USD.
2. Rates come from the **public** AWS Price List (no IAM):
   `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{AmazonBedrock|AmazonBedrockFoundationModels}/current/{region}/index.json`
3. **Local / open network:** omit `AI_BEDROCK_PRICING_FILE` → adapter auto-downloads for `AI_BEDROCK_REGION`.
4. **Kubernetes / locked NetworkPolicy:** curl those URLs in CI → `parseAwsOfferRates` → mount normalized JSON → set `AI_BEDROCK_PRICING_FILE`.

## Why this exists

Amazon Bedrock **does not return USD** on Converse / ConverseStream / InvokeModel. Responses include `usage` (input/output/cache tokens) only. Plumbus multiplies that usage by rates this package loads.

| Mode | Source of rates | When to use |
|------|-----------------|-------------|
| **Pricing file (recommended in containers / k8s)** | You mount a normalized JSON file | Locked-down NetworkPolicy, identical rates across replicas, no thundering-herd CDN fetches |
| **Auto-download** | Package fetches AWS Price List for `region` at warm/TTL | Local dev, single-node, clusters that allow egress to the Price List CDN |

When `pricingFilePath` / `AI_BEDROCK_PRICING_FILE` is set, **auto-download is skipped** (file wins).

## Where rates come from (AWS Price List — public, no IAM)

Host is always **`pricing.us-east-1.amazonaws.com`** (AWS Price List endpoint). The **`{region}` path segment** is the Bedrock region whose on-demand rates you want (e.g. `us-east-1`, `eu-west-1`).

### URL pattern

```text
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{ServiceName}/current/{region}/index.json
```

`{ServiceName}` — this package auto-downloads **both**:

| ServiceName | Typical contents | Approx size (us-east-1) |
|-------------|------------------|-------------------------|
| `AmazonBedrock` | Older / first-party Bedrock SKUs (`model`, `feature: On-demand Inference`, units often **per 1K tokens**) | ~1.4MB |
| `AmazonBedrockFoundationModels` | Marketplace / “Bedrock Edition” Claude SKUs (`servicename`, units often **per 1M tokens**) | ~0.4MB |
| `AmazonBedrockService` | Smaller ancillary index (optional; not required for chat/embed v1) | ~34KB |

No auth headers. Outbound HTTPS only.

### Concrete URL examples

**us-east-1 (N. Virginia):**

```text
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/us-east-1/index.json
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockService/current/us-east-1/index.json
```

**eu-west-1 (Ireland):**

```text
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/eu-west-1/index.json
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/eu-west-1/index.json
```

**us-west-2:**

```text
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-west-2/index.json
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/us-west-2/index.json
```

Replace the final path region with your adapter `region` / `AI_BEDROCK_REGION`. Do **not** change the `pricing.us-east-1.amazonaws.com` host unless AWS documents a different Price List endpoint for your partition (GovCloud differs).

### Pull with curl (CI / laptop)

```bash
REGION=us-east-1
mkdir -p /tmp/bedrock-offers
curl -fsSL \
  "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/${REGION}/index.json" \
  -o "/tmp/bedrock-offers/AmazonBedrock-${REGION}.json"
curl -fsSL \
  "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/${REGION}/index.json" \
  -o "/tmp/bedrock-offers/AmazonBedrockFoundationModels-${REGION}.json"
```

### One-shot: curl + normalize (CI)

Requires `@plumbus/ai-bedrock` resolvable from the working directory (app or monorepo). Export `REGION` / `OUT` so the Node process can read them:

```bash
export REGION=us-east-1
export OUT=bedrock-pricing.json
mkdir -p /tmp/bedrock-offers
curl -fsSL \
  "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/${REGION}/index.json" \
  -o "/tmp/bedrock-offers/AmazonBedrock-${REGION}.json"
curl -fsSL \
  "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/${REGION}/index.json" \
  -o "/tmp/bedrock-offers/AmazonBedrockFoundationModels-${REGION}.json"

node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
import { parseAwsOfferRates } from '@plumbus/ai-bedrock';

const region = process.env.REGION ?? 'us-east-1';
const out = process.env.OUT ?? 'bedrock-pricing.json';
const offers = [
  JSON.parse(readFileSync(`/tmp/bedrock-offers/AmazonBedrock-${region}.json`, 'utf8')),
  JSON.parse(
    readFileSync(`/tmp/bedrock-offers/AmazonBedrockFoundationModels-${region}.json`, 'utf8'),
  ),
];
const rates = parseAwsOfferRates(offers);
const models = Object.fromEntries(
  [...rates].map(([id, r]) => [
    id,
    { inputPerMTok: r.inputPerMTok, outputPerMTok: r.outputPerMTok, kind: r.kind },
  ]),
);
writeFileSync(
  out,
  JSON.stringify({ version: 1, region, generatedAt: new Date().toISOString(), models }, null, 2),
);
console.log('wrote', out, Object.keys(models).length, 'models');
EOF
```

## What the package keeps vs skips

Auto-download and `parseAwsOfferRates()` keep **regional on-demand standard input/output** only (same spirit as core’s OpenAI/Anthropic “standard tier” policy).

**Kept (examples):**

- FoundationModels: `…_InputTokenCount-Units` / `…_OutputTokenCount-Units` (regional)
- AmazonBedrock: `feature: On-demand Inference` + `inferenceType: Input tokens` / `Output tokens`

**Skipped:**

- Global / cross-region inference SKUs (`…_Global-…`)
- Batch
- Latency-optimized
- Reserved / provisioned TPM
- Cache read/write SKUs as separate catalog rows (runtime still applies ~0.1× / 1.25× multipliers when Converse reports cache token fields)

**Unit conversion:** Price List rows may be USD per **1K** or **1M** tokens. The parser normalizes everything to **USD per 1M tokens** (`inputPerMTok` / `outputPerMTok`).

**Display name → family key:** Offer JSON often uses names like `Claude Haiku 4.5 (Amazon Bedrock Edition)`, not `anthropic.claude-haiku-4-5-…`. The package maps known display names to **family keys** (e.g. `anthropic.claude-haiku-4-5`). Lookup then normalizes runtime ids:

| Runtime model id | Family key used for rates |
|------------------|---------------------------|
| `us.anthropic.claude-haiku-4-5-20251001-v1:0` | `anthropic.claude-haiku-4-5` |
| `anthropic.claude-sonnet-4-5-20250929-v1:0` | `anthropic.claude-sonnet-4-5` |
| `amazon.titan-embed-text-v2:0` | `amazon.titan-embed-text-v2` |

Unknown models → cost **`$0`** (inference still works). Extend the normalized file manually for models not in the built-in display-name map.

## Normalized pricing file (v1)

This is what you mount at `pricingFilePath` / `AI_BEDROCK_PRICING_FILE`. Prefer this over raw offer JSON — small enough for a ConfigMap.

```json
{
  "version": 1,
  "region": "us-east-1",
  "generatedAt": "2026-08-12T12:00:00.000Z",
  "models": {
    "anthropic.claude-haiku-4-5": {
      "inputPerMTok": 1.1,
      "outputPerMTok": 5.5,
      "kind": "text"
    },
    "anthropic.claude-sonnet-4-5": {
      "inputPerMTok": 3,
      "outputPerMTok": 15,
      "kind": "text"
    },
    "amazon.titan-embed-text-v2": {
      "inputPerMTok": 0.02,
      "outputPerMTok": 0,
      "kind": "embedding"
    }
  }
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `version` | yes | Must be `1` |
| `models` | yes | Map of model id or family key → rates |
| `models.*.inputPerMTok` | yes | USD per 1M input tokens |
| `models.*.outputPerMTok` | yes | USD per 1M output tokens (`0` for embeddings) |
| `models.*.kind` | no | `text` \| `embedding` \| … (used by `listModels` filters) |
| `region` / `generatedAt` | no | Informational / audit |

### Generate the file with the package parser (recommended)

In a small Node script (CI job or InitContainer), after downloading the two offer JSON files:

```typescript
import { readFileSync, writeFileSync } from 'node:fs';
import { parseAwsOfferRates } from '@plumbus/ai-bedrock';

const region = process.env.REGION ?? 'us-east-1';
const offers = [
  JSON.parse(readFileSync(`/tmp/bedrock-offers/AmazonBedrock-${region}.json`, 'utf8')),
  JSON.parse(
    readFileSync(`/tmp/bedrock-offers/AmazonBedrockFoundationModels-${region}.json`, 'utf8'),
  ),
];

const rates = parseAwsOfferRates(offers);
const models: Record<string, { inputPerMTok: number; outputPerMTok: number; kind?: string }> = {};
for (const [id, rate] of rates) {
  models[id] = {
    inputPerMTok: rate.inputPerMTok,
    outputPerMTok: rate.outputPerMTok,
    kind: rate.kind,
  };
}

writeFileSync(
  'bedrock-pricing.json',
  JSON.stringify(
    {
      version: 1,
      region,
      generatedAt: new Date().toISOString(),
      models,
    },
    null,
    2,
  ),
);
```

Or hand-edit the JSON from the AWS Bedrock pricing page / offer attributes when you only need a few models.

### Sanity-check a rate (Haiku 4.5)

For `us-east-1`, regional on-demand Claude Haiku 4.5 input is typically **`$1.10` / MTok** in FoundationModels (`InputTokenCount-Units`) — **not** `$1.00` (that’s closer to Anthropic API / Global SKUs). If your file has `1.0` for Bedrock Haiku 4.5 regional, fix it.

## Kubernetes / container recipe

1. **CI (preferred) or CronJob** — `curl` the two offer URLs for your region → run the Node script above → publish `bedrock-pricing.json` as a build artifact or ConfigMap.
2. **Mount** the file read-only, e.g. `/config/bedrock-pricing.json`.
3. **Env:**

```bash
AI_DEFAULT_PROVIDER=bedrock
AI_BEDROCK_REGION=us-east-1
AI_BEDROCK_PRICING_FILE=/config/bedrock-pricing.json
AI_BEDROCK_MODEL=anthropic.claude-sonnet-4-5-20250929-v1:0
```

4. **NetworkPolicy:** allow Bedrock Runtime (inference IAM/IRSA). With a pricing file you do **not** need egress to `pricing.us-east-1.amazonaws.com`.
5. **Do not** use a shared Redis/PVC for pricing in v1 — one mounted file per pod (or the same ConfigMap volume) is enough.

Example ConfigMap sketch:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: bedrock-pricing
data:
  bedrock-pricing.json: |
    { "version": 1, "region": "us-east-1", "models": { ... } }
---
# in the Deployment pod spec:
env:
  - name: AI_BEDROCK_PRICING_FILE
    value: /config/bedrock-pricing.json
volumeMounts:
  - name: bedrock-pricing
    mountPath: /config
    readOnly: true
volumes:
  - name: bedrock-pricing
    configMap:
      name: bedrock-pricing
```

## Auto-download mode (no file)

Omit `pricingFilePath`. On warm (first AI call by default), the adapter fetches:

```text
…/AmazonBedrock/current/{region}/index.json
…/AmazonBedrockFoundationModels/current/{region}/index.json
```

Caches in memory (TTL default **24h**, override with `pricingCacheTtlMs` / `AI_BEDROCK_PRICING_TTL_MS`).

**Requirements:** egress HTTPS to `pricing.us-east-1.amazonaws.com`. Failure → `console.warn`; costs stay `$0` until a successful refresh. Inference is **not** blocked.

## Troubleshooting

| Symptom | Check |
|---------|--------|
| `cost` always `0` | Model id not in file / not mapped from offer display name; or auto-download failed (see logs); or using Anthropic-style id without Bedrock rates |
| File load error at runtime | Path missing in container; invalid JSON; `version` ≠ `1`; missing `inputPerMTok` / `outputPerMTok` |
| Rates differ from AWS bill | File stale; Global vs regional SKU; batch / provisioned tiers not modelled |
| Haiku cost too low vs bill | Likely aliased to Anthropic `$1` — use Bedrock regional `$1.10` (us-east-1) from FoundationModels |
| Auto-download works locally, fails in k8s | NetworkPolicy blocking Price List CDN — switch to `AI_BEDROCK_PRICING_FILE` |

## Related

- Package boundary / wiring: [framework.md](./framework.md)
- Conceptual AI docs: `docs/ai/ai-integration.md` (monorepo)
- Types: `BedrockPricingFileV1`, helpers `parseAwsOfferRates`, `parsePricingFile`, `normalizeBedrockModelId`
