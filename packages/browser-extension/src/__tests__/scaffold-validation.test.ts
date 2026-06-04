import { describe, expect, it } from 'vitest';
import { assertValidAppName, assertValidClientExportName } from '../scaffold-validation.js';

describe('assertValidAppName', () => {
  it('rejects empty and control characters', () => {
    expect(() => assertValidAppName('')).toThrow(/Invalid app name/);
    expect(() => assertValidAppName('bad\nname')).toThrow(/Invalid app name/);
  });

  it('accepts normal names', () => {
    expect(() => assertValidAppName('My App')).not.toThrow();
  });
});

describe('assertValidClientExportName', () => {
  it('rejects identifiers starting with a digit', () => {
    expect(() => assertValidClientExportName('2faSetup', 'cap')).toThrow(/Invalid client export/);
  });

  it('accepts camelCase exports', () => {
    expect(() => assertValidClientExportName('listItems', 'cap')).not.toThrow();
  });

  it('rejects reserved JavaScript keywords', () => {
    expect(() => assertValidClientExportName('delete', 'capability "delete"')).toThrow(
      /reserved JavaScript keyword/,
    );
    expect(() => assertValidClientExportName('import', 'flow "import"')).toThrow(
      /reserved JavaScript keyword/,
    );
  });

  it('rejects strict-mode reserved words', () => {
    expect(() => assertValidClientExportName('interface', 'capability "interface"')).toThrow(
      /reserved JavaScript keyword/,
    );
    expect(() => assertValidClientExportName('static', 'capability "static"')).toThrow(
      /reserved JavaScript keyword/,
    );
  });
});
