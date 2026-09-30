// cafaye-ts — the cafaye TypeScript client.
//
// WHAT THIS FILE IS, AND WHAT IT IS NOT
//
// This is the package's public entrypoint, and it is deliberately the smallest
// thing that can honestly be one. It re-exports six generated service clients
// under their service names and does nothing else: no credentials, no base-URL
// resolution, no error mapping, no convenience method that composes two
// services. None of that is here on purpose.
//
// MD6 ruled the structure: "generated types and per-service transport, wrapped by
// one hand-written client… Generated code stays an implementation detail, so a
// generator upgrade can never break the public API." The hand-written client that
// MD6 describes is the `Cafaye` class, and it is NOT in this file. It is packet
// cafaye-ts-02, which owns credential handling (the fleet has two auth models —
// identity mints an opaque server-side session token, everything else uses a
// JWKS-verified bearer JWT), base-URL resolution for self-hosting, and RFC 9457
// problem-to-exception mapping.
//
// WHY THE SIX NAMESPACES AND NOT A FLAT RE-EXPORT
//
// Type names collide across services — `Problem` alone appears in more than one
// document, and so do `Health` and several request/response pairs. Re-exporting
// flat would make the first two services added to the fleet an arbitrary choice
// of which `Problem` a consumer gets, silently. Namespacing by service makes the
// collision impossible to express, and it is the same reason the generated tree
// is one directory per service rather than one flat module.
//
// A consumer who wants a service directly can import it without going through
// this file at all:
//
//     import { createClient } from 'cafaye-ts/services/identity';
//
// That subpath is declared in package.json's `exports` and resolves to the
// generated service's own `index.ts`. Both routes reach the same code; the
// difference is only which one the generator's file layout is allowed to affect.
//
// cafaye-ts-02 replaces this file. Anything added here that composes services,
// holds credentials, or maps errors is packet 2's work, and adding it here would
// conflict with the packet that is supposed to own it.

export * as billing from './services/billing/index.js';
export * as courier from './services/courier/index.js';
export * as darkroom from './services/darkroom/index.js';
export * as identity from './services/identity/index.js';
export * as muse from './services/muse/index.js';
export * as pantry from './services/pantry/index.js';
