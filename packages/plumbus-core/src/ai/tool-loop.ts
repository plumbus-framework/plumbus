// ── Bounded Provider-Native Tool Loop ──
// Runs a provider tool-calling conversation to a non-tool final answer:
// each round asks the model (with tools), executes the returned tool calls,
// feeds observations back, and repeats until the model answers or the round
// budget is exhausted. On exhaustion it makes ONE final request that omits
// BOTH `tools` and `toolChoice` (C2 — never toolChoice:'none'), then returns
// that flat final result. This is the CORE loop (maxRounds default 8, hard
// cap 20). @plumbus/chat MUST NOT call this loop — it runs its own tool loop
// with maxToolRounds default 5 (C10).

import type {
  AITool,
  AIToolCall,
  AIToolChoice,
  AIToolExecutionOptions,
  ChatMessage,
} from './provider.js';
import type {
  AICostContext,
  AIFinalGenerateResult,
  AIService,
  AITokenUsage,
} from '../types/context.js';

/** Observation code emitted (never executed) for a provider tool call whose arguments could not be parsed (§6.4). */
const TOOL_ARGUMENTS_INVALID_CODE = 'tool_arguments_invalid';
/** Observation code emitted when a parsed tool call's executor throws. Internal error detail is NEVER serialized. */
const TOOL_EXECUTION_FAILED_CODE = 'tool_execution_failed';

/** Default round budget when the caller omits `maxRounds` (C10). */
const DEFAULT_MAX_ROUNDS = 8;
/** Hard ceiling on rounds regardless of caller input (C10). */
const HARD_MAX_ROUNDS = 20;
/** Default observation byte cap when the caller omits `maxObservationBytes`. */
const DEFAULT_MAX_OBSERVATION_BYTES = 8192;
/** Floor for the observation byte cap so the smallest valid-JSON envelope always fits. */
const MIN_MAX_OBSERVATION_BYTES = 512;

export interface RunToolLoopParams {
  /** Registered prompt NAME (C8), not prompt text. */
  prompt: string;
  input: Record<string, unknown>;
  messages?: ChatMessage[];
  tools: AITool[];
  toolChoice?: AIToolChoice;
  toolExecution?: AIToolExecutionOptions;
  /** Executor only ever receives parsed calls; invalid-argument calls are never executed (§6.4, §7.7). */
  execute: (call: Extract<AIToolCall, { argumentsStatus: 'parsed' }>) => Promise<unknown>;
  formatObservation?: (args: {
    call: AIToolCall;
    outcome: { ok: true; value: unknown } | { ok: false; code: string; error?: unknown };
  }) => string;
  /** Default 8; hard maximum 20 (C10). Chat MUST NOT call this loop (chat uses maxToolRounds default 5). */
  maxRounds?: number;
  /** Observation byte cap; truncation preserves a valid JSON envelope. */
  maxObservationBytes?: number;
  signal?: AbortSignal;
  costContext?: AICostContext;
  seed?: number;
}

export interface RunToolLoopResult<T = Record<string, unknown>> {
  /** Loop resolves to a non-tool final. C2: after exhausting rounds, the ONE final request
   *  OMITS BOTH `tools` and `toolChoice` (never toolChoice:'none'). */
  final: AIFinalGenerateResult<T>;
  messages: ChatMessage[];
  rounds: number;
  aggregatedUsage: AITokenUsage;
  aggregatedCost: number;
}

/** UTF-8 byte length of a string. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * JSON.stringify that never throws on cyclic references (replaced with the
 * string "[Circular]") or BigInt values (rendered as their decimal string).
 * Duplicate non-cyclic object references (DAG siblings) serialize normally.
 * Uses native JSON.stringify semantics for Date (ISO), toJSON, and
 * function/symbol omission so output is always valid JSON.
 * A top-level `undefined` serializes to "null".
 */
export function safeJsonStringify(value: unknown): string {
  function serialize(val: unknown, path: object[]): string {
    if (val === undefined) return 'null';
    if (val === null || typeof val !== 'object') {
      if (typeof val === 'bigint') return JSON.stringify(val.toString());
      const encoded = JSON.stringify(val);
      return encoded ?? 'null';
    }
    if (path.includes(val)) return '"[Circular]"';

    const withToJson = val as { toJSON?: () => unknown };
    if (typeof withToJson.toJSON === 'function') {
      return serialize(withToJson.toJSON.call(val), path);
    }

    const nextPath = [...path, val];
    if (Array.isArray(val)) {
      const parts: string[] = [];
      for (let i = 0; i < val.length; i++) {
        const el = val[i];
        if (el === undefined || typeof el === 'function' || typeof el === 'symbol') {
          parts.push('null');
        } else {
          parts.push(serialize(el, nextPath));
        }
      }
      return `[${parts.join(',')}]`;
    }

    const record = val as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record)) {
      const prop = record[key];
      if (prop === undefined) continue;
      if (typeof prop === 'function' || typeof prop === 'symbol') continue;
      parts.push(`${JSON.stringify(key)}:${serialize(prop, nextPath)}`);
    }
    return `{${parts.join(',')}}`;
  }

  try {
    return serialize(value, []);
  } catch {
    return 'null';
  }
}

/**
 * Default observation: a `{ type:'untrusted_tool_result', ... }` envelope that
 * is ALWAYS valid JSON, cycle-safe, BigInt-safe, and bounded to `maxBytes`.
 * Failure observations carry only a generic `code` — internal error detail is
 * never serialized into the transcript. Oversized successful results are
 * downgraded to a `{ truncated:true, resultPreview:<string> }` envelope that
 * still parses as JSON.
 */
function defaultFormatObservation(
  args: {
    call: AIToolCall;
    outcome: { ok: true; value: unknown } | { ok: false; code: string; error?: unknown };
  },
  maxBytes: number,
): string {
  const cap = Math.max(maxBytes, MIN_MAX_OBSERVATION_BYTES);
  const header = {
    type: 'untrusted_tool_result' as const,
    toolCallId: args.call.id,
    name: args.call.name,
  };

  if (!args.outcome.ok) {
    // Error detail (args.outcome.error) is intentionally NOT serialized.
    return safeJsonStringify({ ...header, ok: false, code: args.outcome.code });
  }

  const full = safeJsonStringify({ ...header, ok: true, result: args.outcome.value });
  if (byteLength(full) <= cap) return full;

  const raw = safeJsonStringify(args.outcome.value);
  let preview = raw;
  while (preview.length > 0) {
    const candidate = safeJsonStringify({
      ...header,
      ok: true,
      truncated: true,
      resultPreview: preview,
    });
    if (byteLength(candidate) <= cap) return candidate;
    preview = preview.slice(0, Math.floor(preview.length / 2));
  }
  return safeJsonStringify({ ...header, ok: true, truncated: true, resultPreview: '' });
}

/** Add one provider usage record into the running aggregate (mutates `acc`). */
function addUsage(acc: AITokenUsage, next: AITokenUsage): void {
  acc.inputTokens += next.inputTokens;
  acc.outputTokens += next.outputTokens;
  acc.totalTokens += next.totalTokens;
  if (next.cachedInputTokens != null) {
    acc.cachedInputTokens = (acc.cachedInputTokens ?? 0) + next.cachedInputTokens;
  }
  if (next.cacheWriteTokens != null) {
    acc.cacheWriteTokens = (acc.cacheWriteTokens ?? 0) + next.cacheWriteTokens;
  }
}

/**
 * Run the bounded provider-native tool loop against `ai.generateWithUsage`.
 * `outputValidation:'none'` is passed on every request — tool rounds do NOT
 * validate against a prompt output schema.
 */
export async function runToolLoop<T extends Record<string, any> = Record<string, unknown>>(
  ai: AIService,
  params: RunToolLoopParams,
): Promise<RunToolLoopResult<T>> {
  const maxRounds = Math.max(1, Math.min(params.maxRounds ?? DEFAULT_MAX_ROUNDS, HARD_MAX_ROUNDS));
  const maxObservationBytes = Math.max(
    params.maxObservationBytes ?? DEFAULT_MAX_OBSERVATION_BYTES,
    MIN_MAX_OBSERVATION_BYTES,
  );
  // Custom formatter is trusted to bound its own output; the default enforces the cap.
  const formatObservation =
    params.formatObservation ??
    ((a: {
      call: AIToolCall;
      outcome: { ok: true; value: unknown } | { ok: false; code: string; error?: unknown };
    }) => defaultFormatObservation(a, maxObservationBytes));

  // Copy the caller's history — the loop never mutates the input array.
  const messages: ChatMessage[] = params.messages ? [...params.messages] : [];
  const aggregatedUsage: AITokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let aggregatedCost = 0;

  for (let round = 1; round <= maxRounds; round++) {
    const result = await ai.generateWithUsage<T>({
      prompt: params.prompt,
      input: params.input,
      messages,
      tools: params.tools,
      toolChoice: params.toolChoice,
      toolExecution: params.toolExecution,
      outputValidation: 'none',
      signal: params.signal,
      costContext: params.costContext,
      seed: params.seed,
    });
    addUsage(aggregatedUsage, result.usage);
    aggregatedCost += result.cost;

    if (result.finishReason !== 'tool_calls') {
      return { final: result, messages, rounds: round, aggregatedUsage, aggregatedCost };
    }

    // Append the assistant turn carrying the tool calls, then one tool
    // observation per call, in provider order.
    const toolCalls = result.toolCalls;
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls,
      ...(result.providerState ? { providerState: result.providerState } : {}),
    });

    for (const call of toolCalls) {
      let observation: string;
      if (call.argumentsStatus === 'invalid') {
        // Invalid-argument calls are NEVER executed (§6.4, §7.7).
        observation = formatObservation({
          call,
          outcome: { ok: false, code: TOOL_ARGUMENTS_INVALID_CODE },
        });
      } else {
        try {
          const value = await params.execute(call);
          observation = formatObservation({ call, outcome: { ok: true, value } });
        } catch (error) {
          observation = formatObservation({
            call,
            outcome: { ok: false, code: TOOL_EXECUTION_FAILED_CODE, error },
          });
        }
      }
      messages.push({
        role: 'tool',
        content: observation,
        toolCallId: call.id,
        name: call.name,
      });
    }
  }

  // Rounds exhausted → ONE final request OMITTING BOTH tools and toolChoice (C2).
  const final = await ai.generateWithUsage<T>({
    prompt: params.prompt,
    input: params.input,
    messages,
    outputValidation: 'none',
    signal: params.signal,
    costContext: params.costContext,
    seed: params.seed,
  });
  addUsage(aggregatedUsage, final.usage);
  aggregatedCost += final.cost;

  return { final, messages, rounds: maxRounds, aggregatedUsage, aggregatedCost };
}
