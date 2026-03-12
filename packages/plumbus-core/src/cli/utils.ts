// ── CLI Utilities ──
// Shared helpers for CLI commands

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Resolve an absolute path from CWD */
export function resolvePath(...segments: string[]): string {
  return path.resolve(process.cwd(), ...segments);
}

/** Check if a file or directory exists */
export function exists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/** Read a JSON file and parse it */
export function readJson<T = unknown>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

/** Write content to a file, creating directories if needed */
export function writeFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

/** Convert a string to kebab-case */
export function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

/** Convert a string to PascalCase */
export function toPascalCase(str: string): string {
  return str
    .replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

/** Convert a string to camelCase */
export function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** Format output as JSON or human-readable */
export function formatOutput(data: unknown, options: { json?: boolean }): string {
  if (options.json) {
    return JSON.stringify(data, null, 2);
  }
  if (typeof data === 'string') return data;
  return JSON.stringify(data, null, 2);
}

/** Print success message */
export function success(msg: string): void {
  console.log(`✓ ${msg}`);
}

/** Print warning message */
export function warn(msg: string): void {
  console.log(`⚠ ${msg}`);
}

/** Print error message */
export function error(msg: string): void {
  console.error(`✗ ${msg}`);
}

/** Print info message */
export function info(msg: string): void {
  console.log(`ℹ ${msg}`);
}
