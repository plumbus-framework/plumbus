/**
 * Wire-protocol constants shared by the chat server runtime and browser clients.
 *
 * This module MUST stay dependency-free and browser-safe. `@plumbus/chat-ui`
 * imports it from a `"use client"` hook, so anything reachable from here lands
 * in the browser bundle. Importing these names from the package root instead
 * pulls in `runtime/csrf.ts` (node:crypto) and, through `@plumbus/core`, the
 * whole CLI — drizzle-kit and esbuild included — which strict bundlers such as
 * Turbopack refuse to resolve for a client graph.
 */

/** Non-HttpOnly cookie the browser echoes back in the header (double-submit). */
export const CHAT_CSRF_COOKIE_NAME = 'plumbus_chat_csrf';
/** Request header carrying the echoed CSRF token. Fastify lowercases header keys. */
export const CHAT_CSRF_HEADER_NAME = 'x-plumbus-chat-csrf';
