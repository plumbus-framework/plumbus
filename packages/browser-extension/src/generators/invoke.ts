import type { GeneratedFile } from '../types.js';
import { EDITABLE_HEADER } from './constants.js';

export const INVOKE_MESSAGE_TYPE = 'plumbus/invoke';

export function generateInvoke(): GeneratedFile {
  return {
    path: 'src/invoke.ts',
    content: `${EDITABLE_HEADER}
export const INVOKE_MESSAGE_TYPE = '${INVOKE_MESSAGE_TYPE}';

export type InvokeResponse<T = unknown> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { code: string; message: string; status?: number };
    };

function isInvokeResponse(value: unknown): value is InvokeResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.ok === true) return 'data' in v;
  if (v.ok === false && v.error && typeof v.error === 'object') {
    const err = v.error as Record<string, unknown>;
    return typeof err.code === 'string' && typeof err.message === 'string';
  }
  return false;
}

export async function invoke<T = unknown>(
  messageKey: string,
  input: unknown,
): Promise<InvokeResponse<T>> {
  let raw: unknown;
  try {
    raw = await browser.runtime.sendMessage({
      type: INVOKE_MESSAGE_TYPE,
      messageKey,
      input,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to reach the extension background';
    return {
      ok: false,
      error: { code: 'TRANSPORT_ERROR', message },
    };
  }
  if (!isInvokeResponse(raw)) {
    return {
      ok: false,
      error: { code: 'INVALID_RESPONSE', message: 'Background returned an invalid envelope' },
    };
  }
  return raw as InvokeResponse<T>;
}
`,
  };
}
