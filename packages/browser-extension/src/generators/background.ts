import type { BrowserExtensionScaffoldConfig, GeneratedFile } from '../types.js';
import { EDITABLE_HEADER } from './constants.js';

export function generateBackground(config: BrowserExtensionScaffoldConfig): GeneratedFile {
  const registryLines = config.registryEntries
    .map(
      (e) =>
        `  ${JSON.stringify(e.messageKey)}: (input) => wrapHandler(client.${e.exportName} as CapabilityHandler, input),`,
    )
    .join('\n');

  return {
    path: 'entrypoints/background.ts',
    content: `${EDITABLE_HEADER}
import { defineBackground } from 'wxt/utils/define-background';
import * as client from '../src/client/api.js';
import { authHeaders, refreshAuth, clearAuth } from '../src/auth-store.js';
import { INVOKE_MESSAGE_TYPE, type InvokeResponse } from '../src/invoke.js';

type CapabilityHandler = (
  input: unknown,
  options: { headers?: Record<string, string> },
) => Promise<unknown>;

function plumbusError(err: unknown): { code: string; message: string; status?: number } {
  if (err && typeof err === 'object') {
    const e = err as { message?: string; status?: number; code?: string };
    return {
      code: typeof e.code === 'string' ? e.code : 'REQUEST_FAILED',
      message: typeof e.message === 'string' ? e.message : 'Request failed',
      status: typeof e.status === 'number' ? e.status : undefined,
    };
  }
  return { code: 'REQUEST_FAILED', message: String(err) };
}

function isUnauthorized(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'status' in err &&
    (err as { status?: number }).status === 401
  );
}

async function wrapHandler(fn: CapabilityHandler, input: unknown): Promise<InvokeResponse> {
  try {
    const headers = await authHeaders();
    if (!headers.Authorization) {
      return {
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'No access token — log in from the popup' },
      };
    }

    const run = () => fn(input, { headers });

    try {
      const data = await run();
      return { ok: true, data };
    } catch (err) {
      if (!isUnauthorized(err)) {
        return { ok: false, error: plumbusError(err) };
      }
      const refreshed = await refreshAuth();
      if (refreshed.status !== 'authenticated') {
        await clearAuth();
        return {
          ok: false,
          error: {
            code: 'AUTH_EXPIRED',
            message: 'Session expired — log in again',
            status: 401,
          },
        };
      }
      try {
        const retryHeaders = await authHeaders();
        const data = await fn(input, { headers: retryHeaders });
        return { ok: true, data };
      } catch (retryErr) {
        if (!isUnauthorized(retryErr)) {
          return { ok: false, error: plumbusError(retryErr) };
        }
        await clearAuth();
        return { ok: false, error: plumbusError(retryErr) };
      }
    }
  } catch (err) {
    return { ok: false, error: plumbusError(err) };
  }
}

const capabilityRegistry: Record<string, (input: unknown) => Promise<InvokeResponse>> = {
${registryLines}
};

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;
    const msg = message as { type?: string; messageKey?: string; input?: unknown };
    if (msg.type !== INVOKE_MESSAGE_TYPE) return;

    const key = msg.messageKey;
    if (typeof key !== 'string' || !(key in capabilityRegistry)) {
      sendResponse({
        ok: false,
        error: { code: 'UNKNOWN_CAPABILITY', message: \`Unknown capability: \${String(key)}\` },
      });
      return true;
    }

    const handler = capabilityRegistry[key];
    if (!handler) {
      sendResponse({
        ok: false,
        error: { code: 'UNKNOWN_CAPABILITY', message: \`Unknown capability: \${key}\` },
      });
      return true;
    }

    void handler(msg.input)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: plumbusError(err) }));
    return true;
  });
});
`,
  };
}
