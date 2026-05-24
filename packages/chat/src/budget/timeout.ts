export function withTurnTimeout(parent: AbortSignal, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => {
    clearTimeout(timer);
    controller.abort();
  };
  if (parent.aborted) {
    onAbort();
    return controller.signal;
  }
  parent.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}
