import { warnOnce } from '../internal/warn-once.js';

export interface WebSocketOriginPolicy {
  allowlist?: readonly string[];
  allowWithoutOrigin?: boolean;
}

export function checkWebSocketOrigin(
  origin: string | undefined,
  policy: WebSocketOriginPolicy = {},
): { ok: boolean; reason?: string } {
  const allowlist = policy.allowlist ?? [];
  if (allowlist.length === 0) {
    warnOnce(
      'voice.ws-origin-allowlist-empty',
      '[plumbus:voice] websocketOriginAllowlist is empty, so voice websocket handshakes from any (or no) Origin are accepted. Set websocketOriginAllowlist to your app origins.',
    );
    return { ok: true };
  }

  if (!origin) {
    return policy.allowWithoutOrigin
      ? { ok: true }
      : { ok: false, reason: 'Missing Origin header' };
  }

  return allowlist.includes(origin)
    ? { ok: true }
    : { ok: false, reason: 'Origin is not allowed for voice websocket access' };
}
