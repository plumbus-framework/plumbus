/** Log observability hook failures without throwing (H5). */
export function logHookError(hook: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[plumbus] Hook "${hook}" failed: ${message}`);
}
