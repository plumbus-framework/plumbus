import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  isWellFormedRequestId,
  REQUEST_ID_HEADER,
  requestIdOf,
  requestIdsFor,
  resolveRequestId,
  withRequestId,
} from '../request-id.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function raw(headers: Record<string, string | string[]>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('isWellFormedRequestId', () => {
  it.each([
    'gw-2026-11-07.0001',
    '0f8fad5b-d9cb-469f-a165-70867728950e',
    'trace:abc_DEF.123',
    'a'.repeat(128),
  ])('accepts %s', (value) => {
    expect(isWellFormedRequestId(value)).toBe(true);
  });

  it.each([
    '',
    'short',
    'a'.repeat(129),
    '-leading-dash',
    'has space in it',
    'line\nbreak-forged',
    '"quoted-value"',
    'ünïcode-value',
  ])('refuses %j', (value) => {
    expect(isWellFormedRequestId(value)).toBe(false);
  });

  it('refuses non-strings', () => {
    expect(isWellFormedRequestId(undefined)).toBe(false);
    expect(isWellFormedRequestId(12345678)).toBe(false);
  });
});

describe('resolveRequestId', () => {
  it('keeps a well-formed x-request-id', () => {
    expect(resolveRequestId({ [REQUEST_ID_HEADER]: 'edge-req-00001' })).toBe('edge-req-00001');
  });

  it('prefers a well-formed x-correlation-id over x-request-id', () => {
    expect(
      resolveRequestId({ 'x-correlation-id': 'corr-from-client', 'x-request-id': 'req-from-edge' }),
    ).toBe('corr-from-client');
  });

  it('falls through a malformed proposal to the next header', () => {
    expect(
      resolveRequestId({ 'x-correlation-id': 'bad id', 'x-request-id': 'req-from-edge' }),
    ).toBe('req-from-edge');
  });

  it('issues a fresh UUID when nothing well formed is proposed', () => {
    const a = resolveRequestId({ 'x-request-id': 'x\r\nforged: yes' });
    const b = resolveRequestId(undefined);
    expect(a).toMatch(UUID);
    expect(b).toMatch(UUID);
    expect(a).not.toBe(b);
  });

  it('reads the first value of a repeated header', () => {
    expect(resolveRequestId({ 'x-request-id': ['first-value-1', 'second-value'] })).toBe(
      'first-value-1',
    );
  });
});

describe('requestIdOf', () => {
  it('decides once per request, whether given the raw request or a wrapper', () => {
    const request = raw({});
    const first = requestIdOf(request);
    expect(first).toMatch(UUID);
    expect(requestIdOf(request)).toBe(first);
    expect(requestIdOf({ raw: request })).toBe(first);
  });

  it('gives different requests different ids', () => {
    expect(requestIdOf(raw({}))).not.toBe(requestIdOf(raw({})));
  });
});

describe('withRequestId', () => {
  it('adds requestId to the error and keeps everything else', () => {
    const body = { type: 'error', error: { code: 'forbidden', message: 'Access denied' } };
    expect(withRequestId(body, 'req-12345678')).toEqual({
      type: 'error',
      error: { code: 'forbidden', message: 'Access denied', requestId: 'req-12345678' },
    });
  });
});

describe('requestIdsFor', () => {
  it('off: exposes nothing, echoes the raw proposal as before, audits it only when well formed', () => {
    expect(requestIdsFor(raw({ 'x-request-id': 'edge-req-00001' }), undefined)).toEqual({
      echoed: 'edge-req-00001',
      correlationId: 'edge-req-00001',
    });
    expect(requestIdsFor(raw({ 'x-correlation-id': 'bad id' }), { expose: false })).toEqual({
      echoed: 'bad id',
      correlationId: undefined,
    });
    expect(requestIdsFor(raw({}), undefined)).toEqual({
      echoed: undefined,
      correlationId: undefined,
    });
  });

  it('on: one id for header, body and audit, a UUID when the proposal is malformed', () => {
    const ok = requestIdsFor(raw({ 'x-request-id': 'edge-req-00001' }), { expose: true });
    expect(ok).toEqual({
      exposed: 'edge-req-00001',
      echoed: 'edge-req-00001',
      correlationId: 'edge-req-00001',
    });
    const bad = requestIdsFor(raw({ 'x-request-id': 'bad id' }), { expose: true });
    expect(bad.exposed).toMatch(UUID);
    expect(bad.correlationId).toBe(bad.exposed);
  });
});
