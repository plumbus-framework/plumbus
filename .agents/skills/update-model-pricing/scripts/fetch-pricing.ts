/**
 * fetch-pricing.ts
 *
 * Fetches the latest AI model pricing from OpenAI and Anthropic pricing pages,
 * parses the data, and compares against the current MODEL_PRICING table.
 *
 * Usage: npx tsx .agents/skills/update-model-pricing/scripts/fetch-pricing.ts
 * Output: JSON to stdout
 */

// ── Current MODEL_PRICING snapshot (kept in sync manually or by the skill) ──
// This is duplicated here so the script can diff without importing from src/.

const CURRENT_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  // OpenAI: Flagship
  'gpt-5.4': { inputPerMTok: 2.5, outputPerMTok: 15 },
  'gpt-5.4-mini': { inputPerMTok: 0.75, outputPerMTok: 4.5 },
  'gpt-5.4-nano': { inputPerMTok: 0.2, outputPerMTok: 1.25 },
  'gpt-5.4-pro': { inputPerMTok: 30, outputPerMTok: 180 },
  'gpt-5.2': { inputPerMTok: 1.75, outputPerMTok: 14 },
  'gpt-5.2-pro': { inputPerMTok: 21, outputPerMTok: 168 },
  'gpt-5.1': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'gpt-5': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2 },
  'gpt-5-nano': { inputPerMTok: 0.05, outputPerMTok: 0.4 },
  'gpt-5-pro': { inputPerMTok: 15, outputPerMTok: 120 },
  'gpt-4.1': { inputPerMTok: 2, outputPerMTok: 8 },
  'gpt-4.1-mini': { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  'gpt-4.1-nano': { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
  'gpt-4o-2024-05-13': { inputPerMTok: 5, outputPerMTok: 15 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  // OpenAI: Reasoning
  o1: { inputPerMTok: 15, outputPerMTok: 60 },
  'o1-pro': { inputPerMTok: 150, outputPerMTok: 600 },
  'o1-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  o3: { inputPerMTok: 2, outputPerMTok: 8 },
  'o3-pro': { inputPerMTok: 20, outputPerMTok: 80 },
  'o3-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  'o4-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  // OpenAI: Legacy
  'gpt-4-turbo': { inputPerMTok: 10, outputPerMTok: 30 },
  'gpt-4-turbo-2024-04-09': { inputPerMTok: 10, outputPerMTok: 30 },
  'gpt-4-0125-preview': { inputPerMTok: 10, outputPerMTok: 30 },
  'gpt-4-1106-preview': { inputPerMTok: 10, outputPerMTok: 30 },
  'gpt-4-1106-vision-preview': { inputPerMTok: 10, outputPerMTok: 30 },
  'gpt-4-0613': { inputPerMTok: 30, outputPerMTok: 60 },
  'gpt-4-0314': { inputPerMTok: 30, outputPerMTok: 60 },
  'gpt-4': { inputPerMTok: 30, outputPerMTok: 60 },
  'gpt-4-32k': { inputPerMTok: 60, outputPerMTok: 120 },
  'gpt-3.5-turbo': { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  'gpt-3.5-turbo-0125': { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  'gpt-3.5-turbo-1106': { inputPerMTok: 1, outputPerMTok: 2 },
  'gpt-3.5-turbo-0613': { inputPerMTok: 1.5, outputPerMTok: 2 },
  'gpt-3.5-0301': { inputPerMTok: 1.5, outputPerMTok: 2 },
  'gpt-3.5-turbo-instruct': { inputPerMTok: 1.5, outputPerMTok: 2 },
  'gpt-3.5-turbo-16k-0613': { inputPerMTok: 3, outputPerMTok: 4 },
  // Anthropic: Claude
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-1': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-opus-4': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-3-7-sonnet': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-3-5-sonnet': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-3-5-haiku': { inputPerMTok: 0.8, outputPerMTok: 4 },
  'claude-3-opus': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-3-haiku': { inputPerMTok: 0.25, outputPerMTok: 1.25 },
};

// ── Types ──

interface ModelPrice {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
}

interface DiffEntry {
  model: string;
  provider: 'openai' | 'anthropic';
  oldInput?: number;
  oldOutput?: number;
  newInput: number;
  newOutput: number;
}

interface PricingReport {
  fetchedAt: string;
  openai: ModelPrice[];
  anthropic: ModelPrice[];
  diff: {
    added: DiffEntry[];
    changed: DiffEntry[];
    removed: DiffEntry[];
  };
}

// ── Fetch helpers ──

async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'PlumbusFramework-PricingUpdater/1.0',
      Accept: 'text/markdown, text/plain, text/html, */*',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

// ── OpenAI parser ──

function parseOpenAIPricing(markdown: string): ModelPrice[] {
  const prices: ModelPrice[] = [];

  // The OpenAI pricing page uses JSX arrays like:
  //   ["gpt-5.4 (<272K context length)", 2.5, 0.25, 15],
  //   ["gpt-5.4-mini", 0.75, 0.075, 4.5],
  // Format: [name, input, cached_input, output]
  // We only want the standard tier (first TextTokenPricingTables block with tier="standard")

  // Find the standard pricing section
  const standardPaneMatch = markdown.match(
    /data-content-switcher-pane\s+data-value="standard"[\s\S]*?<TextTokenPricingTables[\s\S]*?rows=\{?\[([^\]]*(?:\[[\s\S]*?\][\s,]*)*)\]\}?\s*\/>/,
  );

  if (!standardPaneMatch) {
    // Fallback: find all row arrays with model pricing patterns
    const rowPattern =
      /\["([^"]+?)(?:\s*\([^)]*\))?"\s*,\s*([\d.]+)\s*,\s*(?:[\d.]+|null|""|"-")\s*,\s*([\d.]+)\s*\]/g;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();

    while ((match = rowPattern.exec(markdown)) !== null) {
      const model = match[1]!.trim();
      const input = parseFloat(match[2]!);
      const output = parseFloat(match[3]!);

      // Skip duplicates (batch/flex/priority tiers repeat the same models)
      // We want the first occurrence (standard tier)
      if (seen.has(model) || isNaN(input) || isNaN(output)) continue;
      seen.add(model);

      // Skip non-text models (embedding, moderation, etc. have "-" for output)
      if (isTextModel(model)) {
        prices.push({ model, inputPerMTok: input, outputPerMTok: output });
      }
    }
    return prices;
  }

  // Parse the rows array
  const rowsContent = standardPaneMatch[1]!;
  const rowPattern =
    /\["([^"]+?)(?:\s*\([^)]*\))?"\s*,\s*([\d.]+)\s*,\s*(?:[\d.]+|null|""|"-")\s*,\s*([\d.]+)\s*\]/g;
  let match: RegExpExecArray | null;

  while ((match = rowPattern.exec(rowsContent)) !== null) {
    const model = match[1]!.trim();
    const input = parseFloat(match[2]!);
    const output = parseFloat(match[3]!);

    if (!isNaN(input) && !isNaN(output) && isTextModel(model)) {
      prices.push({ model, inputPerMTok: input, outputPerMTok: output });
    }
  }

  return prices;
}

function isTextModel(name: string): boolean {
  // Exclude embedding, moderation, dall-e, tts, whisper, etc.
  const exclude = /^(text-embedding|omni-moderation|text-moderation|dall|tts|whisper|davinci|babbage|computer-use)/i;
  return !exclude.test(name);
}

// ── Anthropic parser ──

function parseAnthropicPricing(markdown: string): ModelPrice[] {
  const prices: ModelPrice[] = [];

  // Anthropic uses markdown tables:
  // | Claude Opus 4.6     | $5 / MTok  | ... | $25 / MTok |
  // Columns: Model | Base Input | 5m Cache Write | 1h Cache Write | Cache Hits | Output
  const tableRowPattern =
    /\|\s*Claude\s+([^\|]+?)\s*\|\s*\$?([\d.]+)\s*\/\s*MTok\s*\|[^|]*\|[^|]*\|[^|]*\|\s*\$?([\d.]+)\s*\/\s*MTok\s*\|/gi;

  let match: RegExpExecArray | null;
  const seen = new Set<string>();

  while ((match = tableRowPattern.exec(markdown)) !== null) {
    const rawName = match[1]!.trim();
    // Remove markdown links and "(deprecated)" markers
    const cleanName = rawName.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\(deprecated\)/gi, '').trim();
    const input = parseFloat(match[2]!);
    const output = parseFloat(match[3]!);

    if (isNaN(input) || isNaN(output)) continue;

    // Convert to API model name: "Opus 4.6" → "claude-opus-4-6"
    const modelId = claudeDisplayToApiName(cleanName);
    if (seen.has(modelId)) continue;
    seen.add(modelId);

    prices.push({ model: modelId, inputPerMTok: input, outputPerMTok: output });
  }

  return prices;
}

function claudeDisplayToApiName(displayName: string): string {
  // "Opus 4.6" → "claude-opus-4-6"
  // "Sonnet 3.7" → "claude-sonnet-3-7" → but we store as "claude-3-7-sonnet"
  // "Haiku 3.5" → "claude-3-5-haiku"
  // "Opus 3" → "claude-3-opus"
  // "Haiku 3" → "claude-3-haiku"

  const normalized = displayName.toLowerCase().trim();

  // Extract family (opus/sonnet/haiku) and version
  const familyMatch = normalized.match(/^(opus|sonnet|haiku)\s+([\d.]+)$/);
  if (!familyMatch) {
    // Fallback: just kebab-case it
    return `claude-${normalized.replace(/\s+/g, '-').replace(/\./g, '-')}`;
  }

  const family = familyMatch[1]!;
  const version = familyMatch[2]!;
  const versionParts = version.replace(/\./g, '-');

  // Claude 3.x models use "claude-3-X-family" pattern
  // Claude 4+ models use "claude-family-version" pattern
  const majorVersion = parseInt(version.split('.')[0]!, 10);

  if (majorVersion <= 3) {
    // claude-3-opus, claude-3-5-haiku, claude-3-7-sonnet
    return `claude-${versionParts}-${family}`;
  }

  // claude-opus-4-6, claude-sonnet-4-5, claude-haiku-4-5
  return `claude-${family}-${versionParts}`;
}

// ── Diff logic ──

function computeDiff(
  fetched: ModelPrice[],
  provider: 'openai' | 'anthropic',
): { added: DiffEntry[]; changed: DiffEntry[]; removed: DiffEntry[] } {
  const added: DiffEntry[] = [];
  const changed: DiffEntry[] = [];
  const removed: DiffEntry[] = [];

  const fetchedMap = new Map(fetched.map((p) => [p.model, p]));

  // Check fetched models against current
  for (const fp of fetched) {
    const current = CURRENT_PRICING[fp.model];
    if (!current) {
      added.push({
        model: fp.model,
        provider,
        newInput: fp.inputPerMTok,
        newOutput: fp.outputPerMTok,
      });
    } else if (current.inputPerMTok !== fp.inputPerMTok || current.outputPerMTok !== fp.outputPerMTok) {
      changed.push({
        model: fp.model,
        provider,
        oldInput: current.inputPerMTok,
        oldOutput: current.outputPerMTok,
        newInput: fp.inputPerMTok,
        newOutput: fp.outputPerMTok,
      });
    }
  }

  // Check for models in current that are not on the pricing page
  const providerPrefix = provider === 'openai' ? /^(gpt-|o\d)/ : /^claude-/;
  for (const model of Object.keys(CURRENT_PRICING)) {
    if (providerPrefix.test(model) && !fetchedMap.has(model)) {
      const current = CURRENT_PRICING[model]!;
      removed.push({
        model,
        provider,
        oldInput: current.inputPerMTok,
        oldOutput: current.outputPerMTok,
        newInput: current.inputPerMTok,
        newOutput: current.outputPerMTok,
      });
    }
  }

  return { added, changed, removed };
}

// ── Main ──

async function main(): Promise<void> {
  const OPENAI_URL = 'https://developers.openai.com/api/docs/pricing.md';
  const ANTHROPIC_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';

  process.stderr.write('Fetching OpenAI pricing...\n');
  const openaiMarkdown = await fetchPage(OPENAI_URL);

  process.stderr.write('Fetching Anthropic pricing...\n');
  const anthropicMarkdown = await fetchPage(ANTHROPIC_URL);

  process.stderr.write('Parsing pricing data...\n');
  const openaiPrices = parseOpenAIPricing(openaiMarkdown);
  const anthropicPrices = parseAnthropicPricing(anthropicMarkdown);

  const openaiDiff = computeDiff(openaiPrices, 'openai');
  const anthropicDiff = computeDiff(anthropicPrices, 'anthropic');

  const report: PricingReport = {
    fetchedAt: new Date().toISOString(),
    openai: openaiPrices,
    anthropic: anthropicPrices,
    diff: {
      added: [...openaiDiff.added, ...anthropicDiff.added],
      changed: [...openaiDiff.changed, ...anthropicDiff.changed],
      removed: [...openaiDiff.removed, ...anthropicDiff.removed],
    },
  };

  // Summary to stderr
  process.stderr.write(`\n── Pricing Report ──\n`);
  process.stderr.write(`OpenAI models found: ${openaiPrices.length}\n`);
  process.stderr.write(`Anthropic models found: ${anthropicPrices.length}\n`);
  process.stderr.write(`New models: ${report.diff.added.length}\n`);
  process.stderr.write(`Changed prices: ${report.diff.changed.length}\n`);
  process.stderr.write(`Removed (flagged): ${report.diff.removed.length}\n`);

  if (report.diff.added.length > 0) {
    process.stderr.write(`\nNew models:\n`);
    for (const e of report.diff.added) {
      process.stderr.write(`  + ${e.model}: $${e.newInput}/$${e.newOutput} per MTok\n`);
    }
  }
  if (report.diff.changed.length > 0) {
    process.stderr.write(`\nChanged prices:\n`);
    for (const e of report.diff.changed) {
      process.stderr.write(
        `  ~ ${e.model}: $${e.oldInput}/$${e.oldOutput} → $${e.newInput}/$${e.newOutput}\n`,
      );
    }
  }
  if (report.diff.removed.length > 0) {
    process.stderr.write(`\nRemoved from pricing page (review needed):\n`);
    for (const e of report.diff.removed) {
      process.stderr.write(`  - ${e.model}: $${e.oldInput}/$${e.oldOutput}\n`);
    }
  }

  // JSON report to stdout
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
