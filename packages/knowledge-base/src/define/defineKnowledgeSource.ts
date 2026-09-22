import type { KnowledgeProvider } from '../types/provider.js';
import type { KnowledgeSourceDefinition } from '../types/source.js';
import { deepFreeze } from '../internal/deep-freeze.js';
import { KnowledgeErrorCode, knowledgeError } from '../internal/knowledge-error.js';
import { scopeSpecificityRanker } from '../ranker/scope-specificity.js';

const KEBAB_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const warnedTier1Only = new Set<string>();

export interface KnowledgeSourceConfig {
  name: string;
  description?: string;
  domain?: string;
  provider: KnowledgeProvider;
  ranker?: KnowledgeSourceDefinition['ranker'];
}

export function defineKnowledgeSource(config: KnowledgeSourceConfig): KnowledgeSourceDefinition {
  if (!config.name?.trim()) {
    knowledgeError(KnowledgeErrorCode.defineInvalid, 'name is required');
  }
  if (!KEBAB_NAME.test(config.name)) {
    knowledgeError(
      KnowledgeErrorCode.defineInvalid,
      `name must be lowercase kebab-case, got "${config.name}"`,
    );
  }
  if (!config.provider || typeof config.provider.getBlock !== 'function') {
    knowledgeError(KnowledgeErrorCode.defineInvalid, 'provider must implement getBlock');
  }

  const hasTools = typeof config.provider.getTools === 'function';
  const hasSearch = typeof config.provider.search === 'function';
  if (!hasTools && !hasSearch && !warnedTier1Only.has(config.name)) {
    warnedTier1Only.add(config.name);
    console.warn(
      `[@plumbus/knowledge-base] source "${config.name}" implements tier 1 only (no getTools or search)`,
    );
  }

  const definition: KnowledgeSourceDefinition = {
    name: config.name,
    description: config.description,
    domain: config.domain,
    provider: config.provider,
    ranker: config.ranker ?? scopeSpecificityRanker,
  };

  return deepFreeze(definition);
}
