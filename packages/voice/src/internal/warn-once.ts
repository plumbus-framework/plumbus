const warned = new Set<string>();

/** Log a configuration warning at most once per process for the given key. */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** Test hook: forget which warnings were already logged. */
export function resetVoiceWarningsForTests(): void {
  warned.clear();
}
