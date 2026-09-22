// ── Safe flow condition evaluator ──
// Parses a small expression language against flow state (no eval / Function).

import { ErrorDocUrls, ErrorHints } from '../errors/hints.js';

/** Supported flow condition syntax (documented in docs/core-concepts/flows.md). */
export const FLOW_CONDITION_SYNTAX_HINT = ErrorHints.flowConditionSyntax;

export class FlowConditionError extends Error {
  readonly reason = 'unsupported_flow_expression' as const;
  readonly hint = FLOW_CONDITION_SYNTAX_HINT;
  readonly docUrl = ErrorDocUrls.flowConditions;

  constructor(
    message: string,
    readonly expression: string,
  ) {
    super(message);
    this.name = 'FlowConditionError';
  }
}

/**
 * Normalize legacy/doc examples: `ctx.state.foo` → `state.foo`
 */
export function normalizeFlowConditionExpression(expression: string): string {
  return expression.trim().replace(/\bctx\.state\b/g, 'state');
}

/**
 * Evaluate a boolean flow condition against flow state.
 * Returns false on empty expression. Throws FlowConditionError on invalid syntax.
 */
export function evaluateFlowCondition(expression: string, state: unknown): boolean {
  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const normalized = normalizeFlowConditionExpression(trimmed);
  if (/\bfunction\b|\bnew\b|\beval\b|\bimport\b|\brequire\b|[;{}]/.test(normalized)) {
    throw new FlowConditionError(
      `Flow condition contains disallowed syntax. ${FLOW_CONDITION_SYNTAX_HINT}`,
      expression,
    );
  }

  const stateRoot =
    state !== null && typeof state === 'object' ? (state as Record<string, unknown>) : {};

  try {
    const parser = new ConditionParser(normalized, stateRoot);
    const value = parser.parseExpression();
    parser.assertConsumed();
    return Boolean(value);
  } catch (err) {
    if (err instanceof FlowConditionError) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new FlowConditionError(
      `Invalid flow condition: ${detail}. ${FLOW_CONDITION_SYNTAX_HINT}`,
      expression,
    );
  }
}

type Token =
  | { type: 'ident'; value: string }
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'op'; value: string }
  | { type: 'paren'; value: '(' | ')' }
  | { type: 'eof' };

class ConditionParser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(
    private readonly source: string,
    private readonly state: Record<string, unknown>,
  ) {
    this.tokens = tokenize(source);
  }

  parseExpression(): unknown {
    return this.parseOr();
  }

  assertConsumed(): void {
    const tok = this.tokens[this.pos];
    if (tok && tok.type !== 'eof') {
      throw new FlowConditionError(
        `Unexpected token after expression in flow condition`,
        this.source,
      );
    }
  }

  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.matchOp('||')) {
      const right = this.parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseNot();
    while (this.matchOp('&&')) {
      const right = this.parseNot();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  private parseNot(): unknown {
    if (this.matchOp('!')) {
      return !this.parseNot();
    }
    return this.parseComparison();
  }

  private parseComparison(): unknown {
    const left = this.parsePrimary();
    const op = this.peekOp();
    if (
      op === '===' ||
      op === '!==' ||
      op === '==' ||
      op === '!=' ||
      op === '>=' ||
      op === '<=' ||
      op === '>' ||
      op === '<'
    ) {
      this.pos += 1;
      const right = this.parsePrimary();
      return compareValues(left, right, op);
    }
    return left;
  }

  private parsePrimary(): unknown {
    const tok = this.tokens[this.pos];
    if (!tok) {
      throw new FlowConditionError('Unexpected end of expression', this.source);
    }

    if (tok.type === 'paren' && tok.value === '(') {
      this.pos += 1;
      const inner = this.parseExpression();
      this.expectParen(')');
      return inner;
    }

    if (tok.type === 'number' || tok.type === 'string' || tok.type === 'bool') {
      this.pos += 1;
      return tok.value;
    }

    if (tok.type === 'ident') {
      this.pos += 1;
      const path = this.readMemberPath(tok.value);
      return resolveStatePath(this.state, path);
    }

    throw new FlowConditionError(`Unexpected token in condition`, this.source);
  }

  private readMemberPath(first: string): string[] {
    const parts = first.split('.');
    while (this.peekDotIdent()) {
      const next = this.tokens[this.pos];
      if (next?.type === 'ident') {
        parts.push(...next.value.split('.'));
        this.pos += 1;
      }
    }
    return parts;
  }

  private peekDotIdent(): boolean {
    const dot = this.tokens[this.pos];
    const ident = this.tokens[this.pos + 1];
    return dot?.type === 'op' && dot.value === '.' && ident?.type === 'ident';
  }

  private matchOp(value: string): boolean {
    const tok = this.tokens[this.pos];
    if (tok?.type === 'op' && tok.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private peekOp(): string | undefined {
    const tok = this.tokens[this.pos];
    return tok?.type === 'op' ? tok.value : undefined;
  }

  private expectParen(closing: ')'): void {
    const tok = this.tokens[this.pos];
    if (tok?.type === 'paren' && tok.value === closing) {
      this.pos += 1;
      return;
    }
    throw new FlowConditionError(`Expected "${closing}"`, this.source);
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const ops = ['===', '!==', '==', '!=', '>=', '<=', '&&', '||', '!', '>', '<', '.'];

  while (i < source.length) {
    const ch = source[i];
    if (ch === undefined) break;

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i += 1;
      continue;
    }

    let matchedOp: string | undefined;
    for (const op of ops) {
      if (source.startsWith(op, i)) {
        matchedOp = op;
        break;
      }
    }
    if (matchedOp) {
      tokens.push({ type: 'op', value: matchedOp });
      i += matchedOp.length;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let value = '';
      while (i < source.length && source[i] !== quote) {
        value += source[i];
        i += 1;
      }
      i += 1;
      tokens.push({ type: 'string', value });
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let num = ch;
      i += 1;
      while (i < source.length && /[0-9.]/.test(source[i] ?? '')) {
        num += source[i];
        i += 1;
      }
      tokens.push({ type: 'number', value: Number(num) });
      continue;
    }

    if (/[a-zA-Z_$]/.test(ch)) {
      let ident = ch;
      i += 1;
      while (i < source.length && /[a-zA-Z0-9_$.]/.test(source[i] ?? '')) {
        ident += source[i];
        i += 1;
      }
      if (ident === 'true') tokens.push({ type: 'bool', value: true });
      else if (ident === 'false') tokens.push({ type: 'bool', value: false });
      else tokens.push({ type: 'ident', value: ident });
      continue;
    }

    throw new FlowConditionError(`Invalid character "${ch}" in condition`, source);
  }

  tokens.push({ type: 'eof' });
  return tokens;
}

function resolveStatePath(state: Record<string, unknown>, parts: string[]): unknown {
  if (parts[0] === 'state') {
    parts = parts.slice(1);
  }
  let current: unknown = state;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compareValues(left: unknown, right: unknown, op: string): boolean {
  switch (op) {
    case '===':
      return left === right;
    case '!==':
      return left !== right;
    case '==':
      // biome-ignore lint/suspicious/noDoubleEquals: intentional loose equality for flow conditions
      return left == right;
    case '!=':
      // biome-ignore lint/suspicious/noDoubleEquals: intentional loose equality for flow conditions
      return left != right;
    case '>':
      return Number(left) > Number(right);
    case '<':
      return Number(left) < Number(right);
    case '>=':
      return Number(left) >= Number(right);
    case '<=':
      return Number(left) <= Number(right);
    default:
      return false;
  }
}
