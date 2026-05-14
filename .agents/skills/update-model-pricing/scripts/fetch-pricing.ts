// Minimal node-global typing. This file is run via `tsx`, not type-checked
// inside the workspace, and @types/node isn't hoisted to the root for this
// path. Declaring only what we use keeps the IDE quiet without dragging a
// fragile pnpm-path tsconfig along.
declare const process: {
  stderr: { write(s: string): void };
  stdout: { write(s: string): void };
  exit(code: number): never;
};

/**
 * fetch-pricing.ts
 *
 * Fetches the latest AI model pricing from OpenAI and Anthropic pricing pages,
 * parses the data, and compares against the current MODEL_PRICING table.
 *
 * Section-aware: each model row is tagged with a `kind` derived from the
 * surrounding pricing-page section (Flagship/Reasoning/Embeddings/...) or, for
 * grouped tables, the inner `model: "X"` label. No name-pattern matching.
 *
 * Usage: npx tsx .agents/skills/update-model-pricing/scripts/fetch-pricing.ts
 * Output: JSON to stdout
 */

// ── Types ──

type Kind = 'text' | 'embedding' | 'moderation' | 'image' | 'audio';

interface ModelPrice {
  model: string;
  kind: Kind;
  inputPerMTok: number;
  outputPerMTok: number;
}

interface DiffEntry {
  model: string;
  provider: 'openai' | 'anthropic';
  kind?: Kind;
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

// ── Current MODEL_PRICING snapshot (kept in sync manually or by the skill) ──
// Duplicated here so the script can diff without importing from src/.

const CURRENT_PRICING: Record<string, { kind: Kind; inputPerMTok: number; outputPerMTok: number }> =
  {
    // OpenAI: Flagship / Reasoning / Legacy (all text)
    'gpt-5.5': { kind: 'text', inputPerMTok: 5, outputPerMTok: 30 },
    'gpt-5.5-pro': { kind: 'text', inputPerMTok: 30, outputPerMTok: 180 },
    'gpt-5.4': { kind: 'text', inputPerMTok: 2.5, outputPerMTok: 15 },
    'gpt-5.4-mini': { kind: 'text', inputPerMTok: 0.75, outputPerMTok: 4.5 },
    'gpt-5.4-nano': { kind: 'text', inputPerMTok: 0.2, outputPerMTok: 1.25 },
    'gpt-5.4-pro': { kind: 'text', inputPerMTok: 30, outputPerMTok: 180 },
    'gpt-5.2': { kind: 'text', inputPerMTok: 1.75, outputPerMTok: 14 },
    'gpt-5.2-pro': { kind: 'text', inputPerMTok: 21, outputPerMTok: 168 },
    'gpt-5.1': { kind: 'text', inputPerMTok: 1.25, outputPerMTok: 10 },
    'gpt-5': { kind: 'text', inputPerMTok: 1.25, outputPerMTok: 10 },
    'gpt-5-mini': { kind: 'text', inputPerMTok: 0.25, outputPerMTok: 2 },
    'gpt-5-nano': { kind: 'text', inputPerMTok: 0.05, outputPerMTok: 0.4 },
    'gpt-5-pro': { kind: 'text', inputPerMTok: 15, outputPerMTok: 120 },
    'gpt-4.1': { kind: 'text', inputPerMTok: 2, outputPerMTok: 8 },
    'gpt-4.1-mini': { kind: 'text', inputPerMTok: 0.4, outputPerMTok: 1.6 },
    'gpt-4.1-nano': { kind: 'text', inputPerMTok: 0.1, outputPerMTok: 0.4 },
    'gpt-4o': { kind: 'text', inputPerMTok: 2.5, outputPerMTok: 10 },
    'gpt-4o-2024-05-13': { kind: 'text', inputPerMTok: 5, outputPerMTok: 15 },
    'gpt-4o-mini': { kind: 'text', inputPerMTok: 0.15, outputPerMTok: 0.6 },
    o1: { kind: 'text', inputPerMTok: 15, outputPerMTok: 60 },
    'o1-pro': { kind: 'text', inputPerMTok: 150, outputPerMTok: 600 },
    'o1-mini': { kind: 'text', inputPerMTok: 1.1, outputPerMTok: 4.4 },
    o3: { kind: 'text', inputPerMTok: 2, outputPerMTok: 8 },
    'o3-pro': { kind: 'text', inputPerMTok: 20, outputPerMTok: 80 },
    'o3-mini': { kind: 'text', inputPerMTok: 1.1, outputPerMTok: 4.4 },
    'o4-mini': { kind: 'text', inputPerMTok: 1.1, outputPerMTok: 4.4 },
    // OpenAI: Specialized
    'o3-deep-research': { kind: 'text', inputPerMTok: 10, outputPerMTok: 40 },
    'o4-mini-deep-research': { kind: 'text', inputPerMTok: 2, outputPerMTok: 8 },
    'computer-use-preview': { kind: 'text', inputPerMTok: 3, outputPerMTok: 12 },
    // OpenAI: Embeddings
    'text-embedding-3-small': { kind: 'embedding', inputPerMTok: 0.02, outputPerMTok: 0 },
    'text-embedding-3-large': { kind: 'embedding', inputPerMTok: 0.13, outputPerMTok: 0 },
    'text-embedding-ada-002': { kind: 'embedding', inputPerMTok: 0.1, outputPerMTok: 0 },
    // OpenAI: Moderation (free)
    'omni-moderation-latest': { kind: 'moderation', inputPerMTok: 0, outputPerMTok: 0 },
    'text-moderation-latest': { kind: 'moderation', inputPerMTok: 0, outputPerMTok: 0 },
    // OpenAI: Legacy
    'gpt-4-turbo': { kind: 'text', inputPerMTok: 10, outputPerMTok: 30 },
    'gpt-4-turbo-2024-04-09': { kind: 'text', inputPerMTok: 10, outputPerMTok: 30 },
    'gpt-4-0125-preview': { kind: 'text', inputPerMTok: 10, outputPerMTok: 30 },
    'gpt-4-1106-preview': { kind: 'text', inputPerMTok: 10, outputPerMTok: 30 },
    'gpt-4-1106-vision-preview': { kind: 'text', inputPerMTok: 10, outputPerMTok: 30 },
    'gpt-4-0613': { kind: 'text', inputPerMTok: 30, outputPerMTok: 60 },
    'gpt-4-0314': { kind: 'text', inputPerMTok: 30, outputPerMTok: 60 },
    'gpt-4': { kind: 'text', inputPerMTok: 30, outputPerMTok: 60 },
    'gpt-4-32k': { kind: 'text', inputPerMTok: 60, outputPerMTok: 120 },
    'gpt-3.5-turbo': { kind: 'text', inputPerMTok: 0.5, outputPerMTok: 1.5 },
    'gpt-3.5-turbo-0125': { kind: 'text', inputPerMTok: 0.5, outputPerMTok: 1.5 },
    'gpt-3.5-turbo-1106': { kind: 'text', inputPerMTok: 1, outputPerMTok: 2 },
    'gpt-3.5-turbo-0613': { kind: 'text', inputPerMTok: 1.5, outputPerMTok: 2 },
    'gpt-3.5-0301': { kind: 'text', inputPerMTok: 1.5, outputPerMTok: 2 },
    'gpt-3.5-turbo-instruct': { kind: 'text', inputPerMTok: 1.5, outputPerMTok: 2 },
    'gpt-3.5-turbo-16k-0613': { kind: 'text', inputPerMTok: 3, outputPerMTok: 4 },
    'davinci-002': { kind: 'text', inputPerMTok: 2, outputPerMTok: 2 },
    'babbage-002': { kind: 'text', inputPerMTok: 0.4, outputPerMTok: 0.4 },
    // Anthropic: Claude (all text)
    'claude-opus-4-7': { kind: 'text', inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-6': { kind: 'text', inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-5': { kind: 'text', inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-1': { kind: 'text', inputPerMTok: 15, outputPerMTok: 75 },
    'claude-opus-4': { kind: 'text', inputPerMTok: 15, outputPerMTok: 75 },
    'claude-sonnet-4-6': { kind: 'text', inputPerMTok: 3, outputPerMTok: 15 },
    'claude-sonnet-4-5': { kind: 'text', inputPerMTok: 3, outputPerMTok: 15 },
    'claude-sonnet-4': { kind: 'text', inputPerMTok: 3, outputPerMTok: 15 },
    'claude-3-7-sonnet': { kind: 'text', inputPerMTok: 3, outputPerMTok: 15 },
    'claude-3-5-sonnet': { kind: 'text', inputPerMTok: 3, outputPerMTok: 15 },
    'claude-haiku-4-5': { kind: 'text', inputPerMTok: 1, outputPerMTok: 5 },
    'claude-3-5-haiku': { kind: 'text', inputPerMTok: 0.8, outputPerMTok: 4 },
    'claude-3-opus': { kind: 'text', inputPerMTok: 15, outputPerMTok: 75 },
    'claude-3-haiku': { kind: 'text', inputPerMTok: 0.25, outputPerMTok: 1.25 },
  };

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

// ── Section / group classification ──

/**
 * Map a top-level section heading from the OpenAI pricing page to a Kind.
 * Returns `null` for sections that don't carry per-token pricing (image, video, audio).
 * "Specialized models" returns `null` because it uses grouped sub-tables —
 * those are classified by `groupLabelToKind` instead.
 */
function sectionHeadingToKind(heading: string): Kind | null {
  const h = heading.toLowerCase();
  if (h.includes('embedding')) return 'embedding';
  if (h.includes('moderation')) return 'moderation';
  if (h.includes('image') || h.includes('video')) return null;
  if (h.includes('audio') || h.includes('transcription') || h.includes('realtime') || h.includes('speech')) {
    return null;
  }
  if (h.includes('specialized')) return null;
  // Default to text for flagship / reasoning / legacy / finetuning / multimodal-wrapper.
  return 'text';
}

/**
 * Map an inner `model: "X"` label inside a grouped pricing table to a Kind.
 * Returns `null` for tool entries (Web search, File search, Containers, etc.)
 * whose rows aren't model identifiers.
 */
function groupLabelToKind(label: string): Kind | null {
  const l = label.toLowerCase();
  if (l.includes('embedding')) return 'embedding';
  if (l.includes('moderation')) return 'moderation';
  if (l.includes('deep research') || l.includes('computer use')) return 'text';
  return null; // Web search, File search, Containers, Agent Kit, etc.
}

// ── OpenAI parser ──

/**
 * Parse the OpenAI pricing page section-by-section. Each section's heading (or
 * the `model: "X"` label of an inner grouped table) determines the `kind`.
 * No name-pattern matching: kinds come from the page structure.
 */
function parseOpenAIPricing(markdown: string): ModelPrice[] {
  const prices: ModelPrice[] = [];
  const seen = new Set<string>();

  // Find every section heading position. The pricing page uses
  // `<div className="...pricing-section-heading...">…heading text…</div>`.
  const headingPattern = /<div\s+className="[^"]*pricing-section-heading[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  const headings: Array<{ heading: string; start: number; end: number }> = [];

  let hm: RegExpExecArray | null;
  while ((hm = headingPattern.exec(markdown)) !== null) {
    headings.push({
      heading: extractHeadingText(hm[1]!),
      start: hm.index,
      end: hm.index + hm[0].length,
    });
  }

  if (headings.length === 0) return prices;

  // Build sections by pairing each heading with the slice up to the next heading.
  for (let i = 0; i < headings.length; i++) {
    const section = headings[i]!;
    const next = headings[i + 1];
    const sliceEnd = next ? next.start : markdown.length;
    const sectionBody = markdown.slice(section.end, sliceEnd);

    // Within the section body, find the standard-tier pane.
    // (Skip batch/flex/priority panes — duplicate rows with different prices.)
    const paneMatch = sectionBody.match(
      /data-content-switcher-pane\s+data-value="standard"[^>]*>([\s\S]*?)(?=<div\s+data-content-switcher-pane\s+data-value="(?:batch|flex|priority)"|$)/,
    );
    const paneContent = paneMatch ? paneMatch[1]! : sectionBody;

    // Detect grouped sub-table pattern: `{ model: "X", rows: [...] }`
    const groupPattern = /\{\s*model:\s*"([^"]+)"\s*,\s*rows:\s*\[([\s\S]*?)\]\s*,?\s*\}/g;
    const groups: Array<{ label: string; rowsContent: string }> = [];
    let gm: RegExpExecArray | null;
    while ((gm = groupPattern.exec(paneContent)) !== null) {
      groups.push({ label: gm[1]!, rowsContent: gm[2]! });
    }

    if (groups.length > 0) {
      // Grouped: classify by each group's `model:` label.
      for (const grp of groups) {
        const kind = groupLabelToKind(grp.label);
        if (!kind) continue;
        extractFlatRows(grp.rowsContent, kind, prices, seen);
      }
    } else {
      // Flat: classify by section heading.
      const kind = sectionHeadingToKind(section.heading);
      if (!kind) continue;
      extractFlatRows(paneContent, kind, prices, seen);
    }
  }

  return prices;
}

function extractHeadingText(rawHtml: string): string {
  // Strip any nested elements (subheading, meta) and collapse whitespace.
  return rawHtml
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract `[name, input, cached, output]` rows from a JSX rows-array body.
 * Values may be number / null / "" / "-" / "Free"; "-"/""/"Free" → 0.
 * Strips trailing parenthetical context from names (e.g. "(<272K context)").
 */
function extractFlatRows(
  rowsContent: string,
  kind: Kind,
  out: ModelPrice[],
  seen: Set<string>,
): void {
  // Match `["name", v, v, v]` with any value type in cells 2-4.
  const rowPattern = /\["([^"]+?)"\s*,\s*([^,\]]+)\s*,\s*([^,\]]+)\s*,\s*([^,\]]+)\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = rowPattern.exec(rowsContent)) !== null) {
    const rawName = m[1]!.trim();
    const model = rawName.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (seen.has(model)) continue;

    const input = parseCellValue(m[2]!);
    const output = parseCellValue(m[4]!);
    if (input === null) continue;

    seen.add(model);
    out.push({
      model,
      kind,
      inputPerMTok: input,
      outputPerMTok: output ?? 0,
    });
  }
}

function parseCellValue(raw: string): number | null {
  const trimmed = raw.trim();
  // Bare null
  if (trimmed === 'null') return 0;
  // Quoted special values
  if (trimmed === '"-"' || trimmed === '""' || trimmed === '"Free"') return 0;
  // Numeric literal
  const n = parseFloat(trimmed);
  return Number.isNaN(n) ? null : n;
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
    const cleanName = rawName
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\(deprecated\)/gi, '')
      .trim();
    const input = parseFloat(match[2]!);
    const output = parseFloat(match[3]!);

    if (Number.isNaN(input) || Number.isNaN(output)) continue;

    const modelId = claudeDisplayToApiName(cleanName);
    if (seen.has(modelId)) continue;
    seen.add(modelId);

    // Anthropic has no embedding API; every model is a chat/text model.
    prices.push({ model: modelId, kind: 'text', inputPerMTok: input, outputPerMTok: output });
  }

  return prices;
}

function claudeDisplayToApiName(displayName: string): string {
  const normalized = displayName.toLowerCase().trim();
  const familyMatch = normalized.match(/^(opus|sonnet|haiku)\s+([\d.]+)$/);
  if (!familyMatch) {
    return `claude-${normalized.replace(/\s+/g, '-').replace(/\./g, '-')}`;
  }
  const family = familyMatch[1]!;
  const version = familyMatch[2]!;
  const versionParts = version.replace(/\./g, '-');
  const majorVersion = parseInt(version.split('.')[0]!, 10);
  if (majorVersion <= 3) {
    return `claude-${versionParts}-${family}`;
  }
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

  for (const fp of fetched) {
    const current = CURRENT_PRICING[fp.model];
    if (!current) {
      added.push({
        model: fp.model,
        provider,
        kind: fp.kind,
        newInput: fp.inputPerMTok,
        newOutput: fp.outputPerMTok,
      });
    } else if (
      current.inputPerMTok !== fp.inputPerMTok ||
      current.outputPerMTok !== fp.outputPerMTok ||
      current.kind !== fp.kind
    ) {
      changed.push({
        model: fp.model,
        provider,
        kind: fp.kind,
        oldInput: current.inputPerMTok,
        oldOutput: current.outputPerMTok,
        newInput: fp.inputPerMTok,
        newOutput: fp.outputPerMTok,
      });
    }
  }

  const providerPrefix = provider === 'openai' ? /^(gpt-|o\d|text-embedding|omni-moderation|text-moderation|computer-use|davinci|babbage)/
    : /^claude-/;
  for (const model of Object.keys(CURRENT_PRICING)) {
    if (providerPrefix.test(model) && !fetchedMap.has(model)) {
      const current = CURRENT_PRICING[model]!;
      removed.push({
        model,
        provider,
        kind: current.kind,
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

  process.stderr.write(`\n── Pricing Report ──\n`);
  process.stderr.write(`OpenAI models found: ${openaiPrices.length}\n`);
  process.stderr.write(`Anthropic models found: ${anthropicPrices.length}\n`);
  process.stderr.write(`New models: ${report.diff.added.length}\n`);
  process.stderr.write(`Changed prices: ${report.diff.changed.length}\n`);
  process.stderr.write(`Removed (flagged): ${report.diff.removed.length}\n`);

  if (report.diff.added.length > 0) {
    process.stderr.write(`\nNew models:\n`);
    for (const e of report.diff.added) {
      process.stderr.write(`  + [${e.kind}] ${e.model}: $${e.newInput}/$${e.newOutput} per MTok\n`);
    }
  }
  if (report.diff.changed.length > 0) {
    process.stderr.write(`\nChanged prices:\n`);
    for (const e of report.diff.changed) {
      process.stderr.write(
        `  ~ [${e.kind}] ${e.model}: $${e.oldInput}/$${e.oldOutput} → $${e.newInput}/$${e.newOutput}\n`,
      );
    }
  }
  if (report.diff.removed.length > 0) {
    process.stderr.write(`\nRemoved from pricing page (review needed):\n`);
    for (const e of report.diff.removed) {
      process.stderr.write(`  - [${e.kind}] ${e.model}: $${e.oldInput}/$${e.oldOutput}\n`);
    }
  }

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
