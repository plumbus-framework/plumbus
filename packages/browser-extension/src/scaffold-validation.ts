/** Valid JavaScript identifier (client export / registry interpolation). */
export const JS_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Reserved words that cannot be used as `export async function` names. */
export const RESERVED_JS_IDENTIFIERS = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  // Strict-mode reserved (generated client is ESM / always strict)
  'implements',
  'interface',
  'let',
  'package',
  'private',
  'protected',
  'public',
  'static',
  'eval',
  'arguments',
]);

export function assertValidClientExportName(exportName: string, sourceLabel: string): void {
  if (!JS_IDENTIFIER.test(exportName)) {
    throw new Error(
      `Invalid client export "${exportName}" for ${sourceLabel}. Rename the capability or flow so the generated export is a valid JavaScript identifier.`,
    );
  }
  if (RESERVED_JS_IDENTIFIERS.has(exportName)) {
    throw new Error(
      `Invalid client export "${exportName}" for ${sourceLabel}. "${exportName}" is a reserved JavaScript keyword and cannot be used as a generated function name.`,
    );
  }
}

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0 || code === 10 || code === 13 || (code >= 1 && code <= 31)) {
      return true;
    }
  }
  return false;
}

export function assertValidAppName(appName: string): void {
  if (appName.length === 0 || hasControlCharacters(appName)) {
    throw new Error('Invalid app name: must not be empty or contain control characters.');
  }
}
