import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listPaymentsConfigOptions } from '../config/schema.js';

const docsPath = fileURLToPath(new URL('../../../../docs/payments/options.md', import.meta.url));
const instructionsPath = fileURLToPath(new URL('../../instructions/options.md', import.meta.url));

describe('payments options documentation', () => {
  const docs = readFileSync(docsPath, 'utf8');

  it('documents every createPayments() option in docs/payments/options.md', () => {
    const missing = listPaymentsConfigOptions().filter((option) => !docs.includes(`\`${option}\``));
    expect(missing).toEqual([]);
  });

  it('gives every top-level and second-level option its own heading', () => {
    const headings = new Set(
      [...docs.matchAll(/^###\s+`([^`]+)`/gm)].map((match) => match[1] as string),
    );
    const missing = listPaymentsConfigOptions()
      .filter((option) => option.split('.').length <= 2)
      .filter((option) => !headings.has(option));
    expect(missing).toEqual([]);
  });

  it('keeps the agent instructions pointing at every top-level option', () => {
    const instructions = readFileSync(instructionsPath, 'utf8');
    const topLevel = listPaymentsConfigOptions().filter((option) => !option.includes('.'));
    const missing = topLevel.filter((option) => !instructions.includes(`\`${option}`));
    expect(missing).toEqual([]);
  });
});
