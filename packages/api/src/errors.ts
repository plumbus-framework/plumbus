export class ApiManifestError extends Error {
  readonly code: string;

  constructor(message: string, code = 'api.manifest.invalid') {
    super(message);
    this.name = 'ApiManifestError';
    this.code = code;
  }
}
