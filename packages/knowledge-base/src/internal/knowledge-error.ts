export const KnowledgeErrorCode = {
  defineInvalid: 'knowledge.define_invalid',
  duplicateSource: 'knowledge.duplicate_source',
  sourceNotFound: 'knowledge.source_not_found',
  tierNotSupported: 'knowledge.tier_not_supported',
  documentLoadFailed: 'knowledge.document_load_failed',
  translationUnavailable: 'knowledge.translation_unavailable',
  capabilityNotReadonly: 'knowledge.capability_not_readonly',
  ragRetrieveFailed: 'knowledge.rag_retrieve_failed',
} as const;

export class KnowledgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'KnowledgeError';
    this.code = code;
  }
}

export function knowledgeError(code: string, message: string): never {
  throw new KnowledgeError(code, message);
}
