// cafaye-ts — the cafaye TypeScript client.
//
// WHAT THIS FILE IS, AND WHAT IT IS NOT
//
// This is the package's public entrypoint, and it is the whole of the public
// surface: the hand-written `Cafaye` class, the exception types it throws, and
// the six generated namespaces re-exported under their service names. It holds
// no credentials, no base-URL logic, no error mapping and no method that
// composes two services — all of that is in `src/cafaye/`, and the point of
// having a directory behind this file is that the entrypoint itself stays a list
// of names.
//
// MD6 ruled the structure, and it ruled it for a reason that is about lock-in
// rather than taste: "generated types and per-service transport, wrapped by one
// hand-written client … Generated code stays an implementation detail, so a
// generator upgrade can never break the public API." Stainless is the case in
// point — Anthropic acquired it and on 2026-05-18 announced it is winding down
// its hosted products including the generator, with no end date published, and
// every consumer left holding a version range that no longer meant anything.
//
// So: a consumer writes `new Cafaye({ baseUrl })` and reaches every operation
// through a property. They do not import a generated client, do not construct
// one, and do not learn a file layout that a generator upgrade is free to
// change. The generated namespaces ARE still exported from here, because a
// consumer who wants the raw transport with its `{ data, error }` envelope and
// no exception mapping is entitled to it — but they are the alternative, not the
// front door.
//
// WHY THE SIX NAMESPACES AND NOT A FLAT RE-EXPORT
//
// Type names collide across services — `Problem` alone appears in more than one
// document, and so do `Health` and several request/response pairs. Re-exporting
// flat would make the first two services added to the fleet an arbitrary choice
// of which `Problem` a consumer gets, silently. Namespacing by service makes the
// collision impossible to express.
//
// A consumer who wants a service directly can import it without going through
// this file at all:
//
//     import { createClient } from 'cafaye-ts/services/identity/client';
//
// That subpath is declared in package.json's `exports`. Both routes reach the
// same code; the difference is only which one the generator's file layout is
// allowed to affect, and the wrapper is the answer to that question for anyone
// who does not need the raw transport.
//
// WHAT IS NOT HERE
//
// Nothing that composes two services, refreshes a token, retries, paginates, or
// caches. None of it is in `src/cafaye/` either, and its absence is deliberate
// rather than pending: see `REPORT-cafaye-ts-02.md` and the "What this is
// deliberately not" section of README.md. A convenience method that spans
// services is a place to put a policy the platform should own, and putting one
// here would make the fleet's shape a thing a consumer's application code
// depends on.

export { Cafaye, DEFAULT_TIMEOUT_MS } from './cafaye/class.js';
export type {
  BoundNamespace,
  BoundOperation,
  CafayeOptions,
  CafayeServices,
} from './cafaye/class.js';

export {
  CafayeConflictError,
  CafayeConfigurationError,
  CafayeError,
  CafayeForbiddenError,
  CafayeIdempotencyKeyReusedError,
  CafayeNetworkError,
  CafayeNotFoundError,
  CafayeProblemError,
  CafayeProtocolError,
  CafayeRateLimitedError,
  CafayeTimeoutError,
  CafayeUnauthenticatedError,
  CafayeValidationError,
  isCafayeError,
} from './cafaye/errors.js';
export type {
  CafayeErrorKind,
  CafayeFieldError,
  NetworkFailureReason,
} from './cafaye/errors.js';

export { API_TOKEN_PREFIX, SESSION_COOKIE_NAME } from './cafaye/credentials.js';
export type { CredentialKind } from './cafaye/credentials.js';

export { BASE_URL_ENV, baseUrlEnvFor } from './cafaye/base-url.js';
export type { BaseUrlOption, ServiceName } from './cafaye/base-url.js';

export { serviceNames } from './cafaye/services.js';
export type { ServiceClient } from './cafaye/services.js';

export { billing, courier, darkroom, identity, muse, pantry } from './cafaye/services.js';
