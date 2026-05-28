function shouldSkipDeepFreeze(value: unknown): boolean {
  if (typeof value === 'function') {
    return true;
  }
  if (typeof value === 'object' && value !== null && '_def' in value && 'safeParse' in value) {
    return true;
  }
  return false;
}

/**
 * Recursively freeze an object graph (arrays and plain objects).
 * Skips functions and Zod schemas so runtime validation still works.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || shouldSkipDeepFreeze(value)) {
    return value;
  }

  if (Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!shouldSkipDeepFreeze(item)) {
        deepFreeze(item);
      }
    }
    return value;
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    const child = (value as Record<string, unknown>)[key];
    if (!shouldSkipDeepFreeze(child)) {
      deepFreeze(child);
    }
  }

  return value;
}
