/** Zod schemas stay unfrozen: zod 4 fills some properties lazily (`shape`), which fails on a frozen schema. */
function isZodSchema(value: object): boolean {
  return '_zod' in value || ('_def' in value && 'safeParse' in value);
}

export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object' || isZodSchema(obj)) return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}
