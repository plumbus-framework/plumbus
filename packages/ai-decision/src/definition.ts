/** Named decision contracts and registration, using the shared question validator. */
import { z } from '@plumbus/core/zod';
import { DecisionProviderError } from './errors/index.js';
import type { DecisionDefinition, DecisionQuestions } from './types.js';
import { validateDecisionRequest } from './validation.js';

const DefinitionSchema = z.object({
  name: z.string().trim().min(1).max(256),
  description: z.string().max(8192).optional(),
  domain: z.string().trim().min(1).max(256).optional(),
  state: z.instanceof(z.ZodType).optional(),
  provider: z.string().trim().min(1).max(256).optional(),
  model: z.string().trim().min(1).max(256).optional(),
});

function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || value instanceof z.ZodType) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function defineDecision<const Q extends DecisionQuestions>(
  input: Omit<DecisionDefinition<Q>, 'kind'>,
): DecisionDefinition<Q> {
  const parsed = DefinitionSchema.safeParse(input);
  if (!parsed.success)
    throw new DecisionProviderError('decision', 'invalid_request', 'Invalid decision definition');
  const { questions } = validateDecisionRequest(
    { state: '', questions: input.questions },
    'decision',
  );
  return freeze({ ...parsed.data, kind: 'decision' as const, questions });
}

export class DecisionRegistry {
  private readonly definitions = new Map<string, DecisionDefinition>();

  register(definition: DecisionDefinition): void {
    const validated = defineDecision(definition);
    if (this.definitions.has(validated.name))
      throw new DecisionProviderError(
        'decision',
        'configuration',
        `Duplicate decision: ${validated.name}`,
      );
    this.definitions.set(validated.name, validated);
  }

  get(name: string): DecisionDefinition {
    const definition = this.definitions.get(name);
    if (!definition)
      throw new DecisionProviderError('decision', 'configuration', `Unknown decision: ${name}`);
    return definition;
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  getAll(): DecisionDefinition[] {
    return [...this.definitions.values()];
  }
}
