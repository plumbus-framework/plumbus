import type { AuditEvent } from '@plumbus/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_AUDIT_COMPONENT,
  AuthAuditEvents,
  auditOutcomeFor,
  createAuthAuditEmitter,
  describeAuditWriteError,
} from '../audit.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createAuthAuditEmitter', () => {
  it('writes the component and outcome required by the audit_records table', async () => {
    const written: AuditEvent[] = [];
    const audit = createAuthAuditEmitter({
      writer: {
        async write(event) {
          written.push(event);
        },
      },
    });

    await audit.emit(AuthAuditEvents.LoginSucceeded, { providerId: 'cognito', requestId: 'r1' });
    await audit.emit(AuthAuditEvents.LoginFailed, { providerId: 'cognito' });
    await audit.emit(AuthAuditEvents.LoginDenied, { providerId: 'cognito' });

    expect(written).toEqual([
      {
        component: AUTH_AUDIT_COMPONENT,
        action: 'auth.login.succeeded',
        outcome: 'success',
        metadata: { providerId: 'cognito', requestId: 'r1' },
      },
      {
        component: AUTH_AUDIT_COMPONENT,
        action: 'auth.login.failed',
        outcome: 'failure',
        metadata: { providerId: 'cognito' },
      },
      {
        component: AUTH_AUDIT_COMPONENT,
        action: 'auth.login.denied',
        outcome: 'denied',
        metadata: { providerId: 'cognito' },
      },
    ]);
  });

  it('logs the database reason when the write fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onFailure = vi.fn();
    const driverError = Object.assign(
      new Error('null value in column "component" violates not-null constraint'),
      { code: '23502' },
    );
    const audit = createAuthAuditEmitter({
      writer: {
        async write() {
          throw new Error('Failed query: insert into "audit_records" ...', { cause: driverError });
        },
      },
      onFailure,
    });

    await expect(audit.emit(AuthAuditEvents.Logout)).resolves.toBeUndefined();

    expect(onFailure).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      '[@plumbus/auth] audit write failed for auth.logout',
      {
        error: 'null value in column "component" violates not-null constraint',
        code: '23502',
      },
    );
  });
});

describe('auditOutcomeFor', () => {
  it('maps login results to audit outcomes', () => {
    expect(auditOutcomeFor(AuthAuditEvents.LoginStarted)).toBe('success');
    expect(auditOutcomeFor(AuthAuditEvents.LoginCancelled)).toBe('failure');
    expect(auditOutcomeFor(AuthAuditEvents.SessionReplaced)).toBe('success');
    expect(auditOutcomeFor(AuthAuditEvents.Logout)).toBe('success');
  });
});

describe('describeAuditWriteError', () => {
  it('uses the error itself when there is no cause', () => {
    expect(describeAuditWriteError(new Error('connect ECONNREFUSED'))).toEqual({
      error: 'connect ECONNREFUSED',
    });
    expect(describeAuditWriteError('boom')).toEqual({ error: 'boom' });
  });
});
