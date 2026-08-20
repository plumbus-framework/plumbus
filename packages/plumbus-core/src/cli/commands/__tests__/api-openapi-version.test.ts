import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPENAPI_DOCUMENT_VERSION,
  generateOpenApiAtVersion,
  OPENAPI_DOCUMENT_VERSIONS,
  registerApiCommand,
  resolveOpenApiDocumentVersion,
} from '../api.js';

// ── Helpers ──

function findSubcommand(program: Command, pathSegments: string[]): Command {
  let current: Command = program;
  for (const segment of pathSegments) {
    const next = current.commands.find((c) => c.name() === segment);
    if (!next) {
      throw new Error(`Command not found: ${pathSegments.join(' ')} (missing "${segment}")`);
    }
    current = next;
  }
  return current;
}

function openApiVersionOption(command: Command) {
  return command.options.find((o) => o.long === '--openapi-version');
}

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerApiCommand(program);
  return program;
}

// ── resolveOpenApiDocumentVersion ──

describe('resolveOpenApiDocumentVersion', () => {
  it('defaults to 3.0.3 when the flag is absent', () => {
    expect(resolveOpenApiDocumentVersion(undefined)).toEqual({ version: '3.0.3' });
    expect(DEFAULT_OPENAPI_DOCUMENT_VERSION).toBe('3.0.3');
  });

  it('accepts every supported document version', () => {
    for (const version of OPENAPI_DOCUMENT_VERSIONS) {
      expect(resolveOpenApiDocumentVersion(version)).toEqual({ version });
    }
    expect([...OPENAPI_DOCUMENT_VERSIONS]).toEqual(['3.0.3', '3.1.0']);
  });

  it('rejects an unsupported version and names the accepted values', () => {
    const result = resolveOpenApiDocumentVersion('3.2.0');

    expect(result).toEqual({
      error: 'Unsupported OpenAPI version "3.2.0". Supported: 3.0.3, 3.1.0.',
    });
  });

  it('rejects a truncated version rather than guessing a patch level', () => {
    expect(resolveOpenApiDocumentVersion('3.1')).toHaveProperty('error');
    expect(resolveOpenApiDocumentVersion('3.0')).toHaveProperty('error');
  });
});

// ── generateOpenApiAtVersion ──

describe('generateOpenApiAtVersion', () => {
  it('passes the requested version through to the generator', () => {
    const calls: unknown[] = [];
    const api = {
      generateOpenApi: (_caps: never[], _manifest: unknown, options?: unknown) => {
        calls.push(options);
        return { openapi: '3.1.0', paths: {} };
      },
    };

    const result = generateOpenApiAtVersion(api, [], { name: 'partner-api' }, '3.1.0');

    expect(calls).toEqual([{ version: '3.1.0' }]);
    expect(result).toEqual({ doc: { openapi: '3.1.0', paths: {} } });
  });

  it('returns the generated document when the emitted version matches', () => {
    const api = {
      generateOpenApi: () => ({ openapi: '3.0.3', paths: {} }),
    };

    const result = generateOpenApiAtVersion(api, [], {}, '3.0.3');

    expect(result).toEqual({ doc: { openapi: '3.0.3', paths: {} } });
  });

  it('reports a mismatch instead of writing a mislabelled document', () => {
    const api = {
      generateOpenApi: () => ({ openapi: '3.0.3', paths: {} }),
    };

    const result = generateOpenApiAtVersion(api, [], {}, '3.1.0');

    expect(result).toEqual({
      error:
        'Requested OpenAPI 3.1.0, but the installed @plumbus/api emitted 3.0.3. ' +
        'Upgrade @plumbus/api to a release that supports OpenAPI 3.1.0 emission.',
    });
  });

  it('does not rewrite the openapi field itself', () => {
    const api = { generateOpenApi: () => ({ openapi: '3.0.3', paths: {} }) };

    const result = generateOpenApiAtVersion(api, [], {}, '3.0.3');

    expect('doc' in result && (result.doc as { openapi: string }).openapi).toBe('3.0.3');
  });

  it('tolerates a generator whose document carries no openapi field', () => {
    const api = { generateOpenApi: () => ({ paths: {} }) };

    expect(generateOpenApiAtVersion(api, [], {}, '3.1.0')).toEqual({ doc: { paths: {} } });
  });
});

// ── CLI flag surface ──

describe('plumbus api generate openapi --openapi-version', () => {
  it('registers the flag with 3.0.3 as the default', () => {
    const command = findSubcommand(buildProgram(), ['api', 'generate', 'openapi']);
    const option = openApiVersionOption(command);

    expect(option).toBeDefined();
    expect(option?.defaultValue).toBe('3.0.3');
    expect(option?.flags).toBe('--openapi-version <version>');
  });

  it('documents the supported versions in the flag description', () => {
    const command = findSubcommand(buildProgram(), ['api', 'generate', 'openapi']);

    expect(openApiVersionOption(command)?.description).toContain('3.0.3');
    expect(openApiVersionOption(command)?.description).toContain('3.1.0');
  });

  it('parses --openapi-version into opts.openapiVersion', () => {
    const command = findSubcommand(buildProgram(), ['api', 'generate', 'openapi']);
    command.parseOptions(['--out', 'openapi.json', '--openapi-version', '3.1.0']);

    expect(command.opts().openapiVersion).toBe('3.1.0');
  });

  it('keeps --format and --manifest working alongside the new flag', () => {
    const command = findSubcommand(buildProgram(), ['api', 'generate', 'openapi']);
    command.parseOptions([
      '--out',
      'openapi.yaml',
      '--format',
      'yaml',
      '--manifest',
      './contracts/partner.yaml',
    ]);
    const opts = command.opts();

    expect(opts.format).toBe('yaml');
    expect(opts.manifest).toBe('./contracts/partner.yaml');
    expect(opts.openapiVersion).toBe('3.0.3');
  });
});

describe('plumbus api diff --openapi-version', () => {
  it('registers the flag so the current spec can be generated in the baseline dialect', () => {
    const command = findSubcommand(buildProgram(), ['api', 'diff']);
    const option = openApiVersionOption(command);

    expect(option).toBeDefined();
    expect(option?.defaultValue).toBe('3.0.3');
  });

  it('parses --openapi-version alongside --against', () => {
    const command = findSubcommand(buildProgram(), ['api', 'diff']);
    command.parseOptions([
      '--against',
      './published/openapi-v1.json',
      '--openapi-version',
      '3.1.0',
    ]);
    const opts = command.opts();

    expect(opts.against).toBe('./published/openapi-v1.json');
    expect(opts.openapiVersion).toBe('3.1.0');
  });
});
