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
    return { ok: true };
  }

  if (!origin) {
    return policy.allowWithoutOrigin ? { ok: true } : { ok: false, reason: 'Missing Origin header' };
  }

  return allowlist.includes(origin)
    ? { ok: true }
    : { ok: false, reason: 'Origin is not allowed for voice websocket access' };
}
