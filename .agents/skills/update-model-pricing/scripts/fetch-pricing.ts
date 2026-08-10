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
 * Both pages are markdown tables. Section-aware: each model row is tagged with
 * a `kind` derived from the surrounding pricing-page section ("Flagship
 * models", "Specialized models", ...) or, in the Specialized table, the row's
 * own `Category` cell. No name-pattern matching.
 *
 * Only the standard tier is read — Batch, Flex, and Fast mode tables repeat the
 * same models at different rates and are skipped.
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
    'gpt-5.6-sol': { kind: 'text', inputPerMTok: 5, outputPerMTok: 30 },
    'gpt-5.6-terra': { kind: 'text', inputPerMTok: 2, outputPerMTok: 12 },
    'gpt-5.6-luna': { kind: 'text', inputPerMTok: 0.2, outputPerMTok: 1.2 },
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
    'chat-latest': { kind: 'text', inputPerMTok: 5, outputPerMTok: 30 },
    'gpt-5.3-chat-latest': { kind: 'text', inputPerMTok: 1.75, outputPerMTok: 14 },
    'gpt-5.2-chat-latest': { kind: 'text', inputPerMTok: 1.75, outputPerMTok: 14 },
    'gpt-5.3-codex': { kind: 'text', inputPerMTok: 1.75, outputPerMTok: 14 },
    'gpt-5.5-cyber': { kind: 'text', inputPerMTok: 12.5, outputPerMTok: 75 },
    'gpt-5-search-api': { kind: 'text', inputPerMTok: 1.25, outputPerMTok: 10 },
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
    'claude-fable-5': { kind: 'text', inputPerMTok: 10, outputPerMTok: 50 },
    'claude-mythos-5': { kind: 'text', inputPerMTok: 10, outputPerMTok: 50 },
    'claude-opus-5': { kind: 'text', inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-8': { kind: 'text', inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-7': { kind: 'text', inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-6': { kind: 'text', inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-5': { kind: 'text', inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-1': { kind: 'text', inputPerMTok: 15, outputPerMTok: 75 },
    'claude-opus-4': { kind: 'text', inputPerMTok: 15, outputPerMTok: 75 },
    'claude-sonnet-5': { kind: 'text', inputPerMTok: 2, outputPerMTok: 10 },
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
 * Map a top-level section label from the OpenAI pricing page to a Kind.
 *
 * Returns `null` for sections that carry no per-token standard pricing we
 * track: image, video, realtime/audio, transcription, tools, and finetuning
 * (whose rows are training SKUs, not base model rates).
 *
 * "Specialized models" returns `null` because its table classifies per row via
 * a `Category` column — see `groupLabelToKind`.
 */
function sectionLabelToKind(label: string): Kind | null {
  const l = label.toLowerCase();
  if (l.includes('embedding')) return 'embedding';
  if (l.includes('moderation')) return 'moderation';
  if (l.includes('image') || l.includes('video')) return null;
  if (
    l.includes('audio') ||
    l.includes('transcription') ||
    l.includes('realtime') ||
    l.includes('speech')
  ) {
    return null;
  }
  if (l.includes('specialized')) return null;
  if (l.includes('finetuning') || l.includes('fine-tuning')) return null;
  if (l.includes('tool')) return null;
  // Flagship / reasoning / legacy models are all text.
  return 'text';
}

/**
 * Map a `Category` cell inside the Specialized models table to a Kind.
 * Returns `null` for categories whose rows aren't billable model identifiers.
 */
function groupLabelToKind(label: string): Kind | null {
  const l = label.toLowerCase();
  if (l.includes('embedding')) return 'embedding';
  if (l.includes('moderation')) return 'moderation';
  if (
    l.includes('deep research') ||
    l.includes('computer use') ||
    l.includes('chatgpt') ||
    l.includes('codex') ||
    l.includes('cyber') ||
    l.includes('search')
  ) {
    return 'text';
  }
  return null; // Web search, File search, Containers, Agent Kit, etc.
}

// ── OpenAI parser ──

/** Pricing tiers the page exposes. Only `standard` feeds the catalog. */
const TIER_LABELS = new Set(['standard', 'batch', 'flex', 'fast mode', 'priority']);

interface MarkdownTable {
  header: string[];
  rows: string[][];
}

/**
 * Parse the OpenAI pricing page.
 *
 * The page is a sequence of bare section labels ("Flagship models",
 * "Specialized models", …), bare tier labels ("Standard", "Batch", "Flex",
 * "Fast mode"), and `### … data` headings each followed by a markdown table.
 * We walk it linearly, tracking the section and tier currently in scope, and
 * only keep tables under the `standard` tier. Kinds come from the page
 * structure — the section label, or the row's `Category` cell — never from
 * model-name patterns.
 */
function parseOpenAIPricing(markdown: string): ModelPrice[] {
  const prices: ModelPrice[] = [];
  const seen = new Set<string>();
  const lines = markdown.split('\n');

  let section = '';
  let tier = 'standard';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    // A `### <Tier> pricing data` heading names its own tier; the generic
    // `### Grouped Pricing Table data` / `### Pricing Table data` headings
    // inherit the tier from the most recent bare tier label.
    if (line.startsWith('###')) {
      const heading = line.replace(/^#+\s*/, '').toLowerCase();
      const named = heading.match(/^(standard|batch|flex|fast|priority)\s+pricing data$/);
      if (named) {
        tier = named[1] === 'fast' ? 'fast mode' : named[1]!;
      }

      const table = readMarkdownTable(lines, i + 1);
      if (!table) continue;
      i = table.endIndex;

      if (tier !== 'standard') continue;
      collectTableRows(table.table, section, prices, seen);
      continue;
    }

    // Bare tier label (e.g. a line reading just "Batch").
    if (TIER_LABELS.has(line.toLowerCase())) {
      tier = line.toLowerCase();
      continue;
    }

    // Bare section label. Anything that isn't a table row, blockquote, link, or
    // prose sentence is treated as a section heading; a new section resets the
    // tier because each section's first pane is its standard one.
    if (isSectionLabel(line)) {
      section = line;
      tier = 'standard';
    }
  }

  return prices;
}

/**
 * Section labels on this page are short bare lines like "Flagship models" or
 * "Tools" — no markdown syntax, no sentence punctuation.
 */
function isSectionLabel(line: string): boolean {
  if (line.startsWith('|') || line.startsWith('>') || line.startsWith('#')) return false;
  if (line.startsWith('*') || line.startsWith('-') || line.startsWith('[')) return false;
  if (/[.:;]$/.test(line)) return false;
  if (line.includes('](')) return false;
  return line.split(/\s+/).length <= 6;
}

/** Read the markdown table starting at or just after `start`. */
function readMarkdownTable(
  lines: string[],
  start: number,
): { table: MarkdownTable; endIndex: number } | null {
  let i = start;
  while (i < lines.length && !lines[i]!.trim().startsWith('|')) {
    if (lines[i]!.trim().startsWith('#')) return null; // hit the next heading first
    i++;
  }
  if (i >= lines.length) return null;

  const header = splitRow(lines[i]!);
  i++;
  // Separator row (| --- | --- |)
  if (i < lines.length && /^\|[\s:|-]+\|$/.test(lines[i]!.trim())) i++;

  const rows: string[][] = [];
  while (i < lines.length && lines[i]!.trim().startsWith('|')) {
    rows.push(splitRow(lines[i]!));
    i++;
  }

  return { table: { header, rows }, endIndex: i - 1 };
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Find a column by exact header name, trying each candidate in order. */
function columnIndex(header: string[], ...candidates: string[]): number {
  for (const candidate of candidates) {
    const index = header.findIndex((h) => h.toLowerCase() === candidate);
    if (index !== -1) return index;
  }
  return -1;
}

/**
 * Pull model rates out of one standard-tier table.
 *
 * Flagship tables price short and long context separately; we track the short
 * (base) context rates. Specialized tables prefix each row with a `Category`
 * cell that determines the kind.
 */
function collectTableRows(
  table: MarkdownTable,
  section: string,
  out: ModelPrice[],
  seen: Set<string>,
): void {
  const { header, rows } = table;
  const modelCol = columnIndex(header, 'model');
  if (modelCol === -1) return;

  const inputCol = columnIndex(header, 'short context input', 'input');
  const outputCol = columnIndex(header, 'short context output', 'output', 'output / cost');
  if (inputCol === -1 || outputCol === -1) return;

  const categoryCol = columnIndex(header, 'category');
  const sectionKind = sectionLabelToKind(section);
  // A table with no Category column and an unpriced section is not ours.
  if (categoryCol === -1 && !sectionKind) return;

  for (const row of rows) {
    const kind = categoryCol === -1 ? sectionKind : groupLabelToKind(row[categoryCol] ?? '');
    if (!kind) continue;

    const rawName = row[modelCol] ?? '';
    // Drop trailing qualifiers: "(<272K context length)", "(legacy)", "(data sharing)".
    const model = rawName.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (!model || seen.has(model)) continue;

    const input = parseCellValue(row[inputCol] ?? '');
    if (input === null) continue;
    const output = parseCellValue(row[outputCol] ?? '');

    seen.add(model);
    out.push({ model, kind, inputPerMTok: input, outputPerMTok: output ?? 0 });
  }
}

/**
 * Parse a price cell.
 *
 * "Free" is an explicit zero rate (moderation). "-" and "" mean the column
 * doesn't apply, and rates quoted per minute / character / call aren't
 * per-token — both return null. Callers decide what a null means per column:
 * a null *input* drops the row (`gpt-5.4-cyber` is listed with no price at
 * all), while a null *output* is a genuine zero (embeddings, moderation).
 */
function parseCellValue(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === 'free') return 0;
  if (trimmed === '-' || trimmed === '') return null;
  if (trimmed.includes('/')) return null; // "$0.034 / minute", "$15.00 / 1M characters"
  const n = parseFloat(trimmed.replace(/^\$/, ''));
  return Number.isNaN(n) ? null : n;
}

// ── Anthropic parser ──

function parseAnthropicPricing(markdown: string): ModelPrice[] {
  const prices: ModelPrice[] = [];

  // Anthropic uses markdown tables:
  // | Claude Opus 4.6     | $5 / MTok  | ... | $25 / MTok |
  // Columns: Model | Base Input | 5m Cache Write | 1h Cache Write | Cache Hits | Output
  // Every group excludes newlines so a row can never chain into the next one —
  // the narrower Batch and Fast-mode tables would otherwise splice together and
  // yield rates that appear on no single row.
  const tableRowPattern =
    /\|\s*Claude\s+([^|\n]+?)\s*\|\s*\$?([\d.]+)\s*\/\s*MTok\s*\|[^|\n]*\|[^|\n]*\|[^|\n]*\|\s*\$?([\d.]+)\s*\/\s*MTok\s*\|/gi;

  let match: RegExpExecArray | null;
  const seen = new Set<string>();

  while ((match = tableRowPattern.exec(markdown)) !== null) {
    const rawName = match[1]!.trim();
    // Unwrap markdown links so the qualifier text they carry can be inspected:
    // "Claude Sonnet 5 [through August 31, 2026](…)" → "Sonnet 5 through August 31, 2026".
    const unlinked = rawName.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();

    // The table lists a model twice when a price change is scheduled. Keep the
    // rate in effect today and report the future one separately, rather than
    // letting row order decide which price lands in the catalog.
    if (/\bstarting\s+[A-Z][a-z]+\s+\d/.test(unlinked)) {
      process.stderr.write(
        `  (upcoming) ${unlinked}: $${match[2]}/$${match[3]} per MTok — not applied\n`,
      );
      continue;
    }

    // Drop availability/deprecation qualifiers: "(limited availability)",
    // "(retired, except on Bedrock and Google Cloud)", "through August 31, 2026".
    const cleanName = unlinked
      .replace(/\([^)]*\)/g, '')
      .replace(/\b(through|until)\s+[A-Z][a-z]+\s+\d.*$/, '')
      .replace(/\s+/g, ' ')
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

  const providerPrefix = provider === 'openai' ? /^(gpt-|o\d|chat-latest|text-embedding|omni-moderation|text-moderation|computer-use|davinci|babbage)/
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
  process.stderr.write(`Not parsed from page (in catalog): ${report.diff.removed.length}\n`);

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
    process.stderr.write(`\nIn catalog but not parsed from page (review needed):\n`);
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
