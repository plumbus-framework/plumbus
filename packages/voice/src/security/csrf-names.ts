/**
 * Browser-readable names for voice CSRF protection. Kept free of Node imports so
 * `@plumbus/voice/client` can re-export them.
 */
/** Cookie the voice routes set when `csrfSecret` + `externalBaseUrl` are configured. */
export const VOICE_CSRF_COOKIE_NAME = 'plumbus_voice_csrf';
/** Header a browser client echoes the cookie value into on cookie-authenticated writes. */
export const VOICE_CSRF_HEADER_NAME = 'x-plumbus-voice-csrf';
