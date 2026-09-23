import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from '@plumbus/core/zod';
import { createLayaDecisionAdapter } from '../index.js';

let child: ChildProcess;
let baseUrl: string;
beforeAll(async () => {
  child = spawn('python3', ['-B', 'service/fixtures/fake_server.py'], {
    cwd: new URL('../..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Python fixture did not become ready')), 5000);
    const fail = () => {
      clearTimeout(timer);
      reject(new Error('Python fixture exited before readiness'));
    };
    child.once('error', fail);
    child.once('exit', fail);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (!output.includes('\n')) return;
      clearTimeout(timer);
      child.off('exit', fail);
      child.off('error', fail);
      try {
        resolve(
          z
            .object({ port: z.number().int().positive() })
            .parse(JSON.parse(output.split('\n')[0] ?? '')).port,
        );
      } catch (error) {
        reject(error);
      }
    });
  });
  baseUrl = `http://127.0.0.1:${port}/v1`;
});
afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
});

describe('Laya Node-to-Python HTTP end to end (fake inference)', () => {
  it('[L21] carries all three primitives and Hebrew through the real service', async () => {
    const result = await createLayaDecisionAdapter({ baseUrl, apiKey: 'e2e-key' }).decide({
      state: { text: 'נא להחזיר כסף 😀' },
      questions: {
        team: {
          type: 'choice',
          instructions: { rule: 'Team?' },
          criteria: { billing: null, other: 'Other' },
        },
        urgency: { type: 'score', instructions: 'Urgent?', criteria: ['Low', 'High'] },
        refund: {
          type: 'probability',
          instructions: 'Refund?',
          criteria: { true: 'Asked', false: 'Not asked' },
        },
      },
    });
    expect(result.answers.team.choice).toBe('billing');
    expect(result.answers.urgency.score).toBe(1);
    expect(result.answers.refund.probability).toBe(0.75);
    expect(result).toMatchObject({ cost: null, routing: { model: 'multilingual' } });
  });
  it('[L22] rejects a wrong service key with one HTTP attempt', async () => {
    await expect(
      createLayaDecisionAdapter({ baseUrl, apiKey: 'wrong' }).decide({
        state: '',
        questions: { p: { type: 'probability', instructions: '?' } },
      }),
    ).rejects.toMatchObject({ kind: 'http', httpStatus: 401, attempts: 1 });
  });
});
