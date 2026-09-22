import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeProvider } from '../types/provider.js';
import type { ScoredBlock } from '../types/result.js';
import type { KnowledgeScope } from '../types/scope.js';
import { KnowledgeError, KnowledgeErrorCode } from '../internal/knowledge-error.js';
import { filterBlocksByScope, scopeSpecificityRanker } from '../ranker/scope-specificity.js';
import { packBlocks } from '../ranker/pack-blocks.js';

interface ParsedDoc {
  text: string;
  scope?: KnowledgeScope;
}

export function documentCollection(opts: {
  root: string;
  frontmatterParser?: (raw: string) => {
    scope?: KnowledgeScope;
    metadata?: Record<string, unknown>;
  };
  ranker?: (blocks: ScoredBlock[], scope: KnowledgeScope) => ScoredBlock[];
}): KnowledgeProvider {
  const factoryRanker = opts.ranker;
  let loadPromise: Promise<ParsedDoc[]> | null = null;
  let cachedDocs: ParsedDoc[] | null = null;

  async function loadDocs(): Promise<ParsedDoc[]> {
    if (cachedDocs) return cachedDocs;
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          const files = await listMarkdownFiles(opts.root);
          const docs: ParsedDoc[] = [];
          for (const file of files) {
            const raw = await readFile(file, 'utf8');
            docs.push(parseMarkdownDoc(raw, opts.frontmatterParser));
          }
          cachedDocs = docs;
          return docs;
        } catch (err) {
          loadPromise = null;
          const message = err instanceof Error ? err.message : String(err);
          throw new KnowledgeError(
            KnowledgeErrorCode.documentLoadFailed,
            `failed to load documents from "${opts.root}": ${message}`,
          );
        }
      })();
    }
    return loadPromise;
  }

  return {
    async getBlock(_ctx, scope, { maxTokens, ranker: callRanker } = {}) {
      const docs = await loadDocs();
      const blocks: ScoredBlock[] = docs.map((d, index) => ({
        text: d.text,
        score: docs.length - index,
        scope: d.scope,
      }));
      const filtered = filterBlocksByScope(blocks, scope);
      const activeRanker = factoryRanker ?? callRanker ?? scopeSpecificityRanker;
      const ranked = activeRanker(filtered, scope);
      return packBlocks(ranked, maxTokens);
    },
    async getTools() {
      throw new KnowledgeError(KnowledgeErrorCode.tierNotSupported, 'tier 2 getTools');
    },
    async search() {
      throw new KnowledgeError(KnowledgeErrorCode.tierNotSupported, 'tier 3 search');
    },
  };
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const stat = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (!stat) return [];
  const files: string[] = [];
  for (const entry of stat) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(path)));
    } else if (entry.name.endsWith('.md')) {
      files.push(path);
    }
  }
  return files;
}

function parseMarkdownDoc(
  raw: string,
  frontmatterParser?: (rawFm: string) => {
    scope?: KnowledgeScope;
    metadata?: Record<string, unknown>;
  },
): ParsedDoc {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(raw);
  if (!fmMatch) {
    return { text: raw.trim() };
  }
  const fmRaw = fmMatch[1] ?? '';
  const body = fmMatch[2] ?? '';
  const parsed = frontmatterParser?.(fmRaw) ?? parseSimpleYamlFrontmatter(fmRaw);
  return { text: body.trim(), scope: parsed.scope };
}

function parseSimpleYamlFrontmatter(raw: string): {
  scope?: KnowledgeScope;
  metadata?: Record<string, unknown>;
} {
  const scope: KnowledgeScope = {};
  for (const line of raw.split('\n')) {
    const m = /^(\w+):\s*(.+)$/u.exec(line.trim());
    if (!m) continue;
    const key = m[1];
    const value = m[2]?.trim();
    if (!key || value === undefined) continue;
    if (key === 'audience' || key === 'locale' || key === 'tenantId') {
      scope[key] = value;
    }
  }
  return { scope: Object.keys(scope).length > 0 ? scope : undefined };
}
