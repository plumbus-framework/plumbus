import { describe, expect, it } from 'vitest';
import { diffOpenApi } from '../diff.js';
import type { OpenApiDocument } from '../../openapi/types.js';

const baseDoc = (): OpenApiDocument => ({
  openapi: '3.0.3',
  info: { title: 't', version: '1' },
  paths: {
    '/api/v1/items': {
      get: {
        operationId: 'listItems',
        responses: { '200': { description: 'ok' } },
        'x-plumbus-test': { enabled: true },
      },
    },
  },
});

describe('diffOpenApi', () => {
  it('detects breaking removed operation', () => {
    const prev = baseDoc();
    const next: OpenApiDocument = { ...prev, paths: {} };
    const diff = diffOpenApi(prev, next);
    expect(diff.breaking.some((b) => b.kind === 'removed-operation')).toBe(true);
  });

  it('detects non-breaking added operation', () => {
    const prev = baseDoc();
    const next: OpenApiDocument = {
      ...prev,
      paths: {
        ...prev.paths,
        '/api/v1/new': {
          post: { operationId: 'createItem', responses: { '201': { description: 'created' } } },
        },
      },
    };
    const diff = diffOpenApi(prev, next);
    expect(diff.nonBreaking.some((b) => b.kind === 'added-operation')).toBe(true);
  });

  it('detects breaking changed method', () => {
    const prev = baseDoc();
    const next: OpenApiDocument = {
      ...prev,
      paths: {
        '/api/v1/items': {
          post: { operationId: 'listItems', responses: { '200': { description: 'ok' } } },
        },
      },
    };
    const diff = diffOpenApi(prev, next);
    expect(diff.breaking.some((b) => b.kind === 'changed-method')).toBe(true);
  });

  it('detects breaking removed test behavior', () => {
    const prev = baseDoc();
    const next: OpenApiDocument = {
      ...prev,
      paths: {
        '/api/v1/items': {
          get: { operationId: 'listItems', responses: { '200': { description: 'ok' } } },
        },
      },
    };
    const diff = diffOpenApi(prev, next);
    expect(diff.breaking.some((b) => b.kind === 'removed-test-behavior')).toBe(true);
  });

  it('detects breaking removed response field', () => {
    const prev: OpenApiDocument = {
      ...baseDoc(),
      paths: {
        '/api/v1/items': {
          get: {
            operationId: 'listItems',
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'object',
                          properties: { id: { type: 'string' }, name: { type: 'string' } },
                          required: ['id', 'name'],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const next: OpenApiDocument = {
      ...prev,
      paths: {
        '/api/v1/items': {
          get: {
            operationId: 'listItems',
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'object',
                          properties: { id: { type: 'string' } },
                          required: ['id'],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const diff = diffOpenApi(prev, next);
    expect(diff.breaking.some((b) => b.kind === 'removed-response-field')).toBe(true);
  });

  it('detects breaking added required request input', () => {
    const prev: OpenApiDocument = {
      ...baseDoc(),
      paths: {
        '/api/v1/items': {
          post: {
            operationId: 'createItem',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                    required: ['name'],
                  },
                },
              },
            },
            responses: { '201': { description: 'created' } },
          },
        },
      },
    };
    const next: OpenApiDocument = {
      ...prev,
      paths: {
        '/api/v1/items': {
          post: {
            operationId: 'createItem',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      category: { type: 'string' },
                    },
                    required: ['name', 'category'],
                  },
                },
              },
            },
            responses: { '201': { description: 'created' } },
          },
        },
      },
    };
    const diff = diffOpenApi(prev, next);
    expect(diff.breaking.some((b) => b.kind === 'added-required-input')).toBe(true);
  });

  it('treats response field became required as non-breaking', () => {
    const prev: OpenApiDocument = {
      ...baseDoc(),
      paths: {
        '/api/v1/items': {
          get: {
            operationId: 'listItems',
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'object',
                          properties: { id: { type: 'string' }, name: { type: 'string' } },
                          required: ['id'],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const next: OpenApiDocument = {
      ...prev,
      paths: {
        '/api/v1/items': {
          get: {
            operationId: 'listItems',
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'object',
                          properties: { id: { type: 'string' }, name: { type: 'string' } },
                          required: ['id', 'name'],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const diff = diffOpenApi(prev, next);
    expect(diff.breaking.some((b) => b.kind === 'response-field-became-required')).toBe(false);
    expect(diff.nonBreaking.some((b) => b.kind === 'response-field-became-required')).toBe(true);
  });

  it('includes path on changed-path findings', () => {
    const prev = baseDoc();
    const next: OpenApiDocument = {
      ...prev,
      paths: {
        '/api/v1/new-items': {
          get: { operationId: 'listItems', responses: { '200': { description: 'ok' } } },
        },
      },
    };
    const diff = diffOpenApi(prev, next);
    const changed = diff.breaking.find((b) => b.kind === 'changed-path');
    expect(changed?.path).toBe('/api/v1/items');
  });

  it('detects breaking tightened scopes for oauth2 security', () => {
    const prev: OpenApiDocument = {
      ...baseDoc(),
      paths: {
        '/api/v1/items': {
          get: {
            operationId: 'listItems',
            security: [{ oauth2: ['items:read'] }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const next: OpenApiDocument = {
      ...prev,
      paths: {
        '/api/v1/items': {
          get: {
            operationId: 'listItems',
            security: [{ oauth2: ['items:read', 'items:admin'] }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const diff = diffOpenApi(prev, next);
    expect(diff.breaking.some((b) => b.kind === 'tightened-scopes')).toBe(true);
  });

  it('detects breaking tightened scopes for named bearer schemes', () => {
    const prev: OpenApiDocument = {
      ...baseDoc(),
      paths: {
        '/api/v1/items': {
          get: {
            operationId: 'listItems',
            security: [{ bearer: [] }],
            'x-plumbus-required-scopes': ['items:read'],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const next: OpenApiDocument = {
      ...prev,
      paths: {
        '/api/v1/items': {
          get: {
            operationId: 'listItems',
            security: [{ bearer: [] }],
            'x-plumbus-required-scopes': ['items:read', 'items:admin'],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const diff = diffOpenApi(prev, next);
    expect(diff.breaking.some((b) => b.kind === 'tightened-scopes')).toBe(true);
  });
});
