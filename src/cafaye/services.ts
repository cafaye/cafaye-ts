// The six generated namespaces, imported exactly once.
//
// WHY THIS FILE EXISTS
//
// Two reasons, and the first is the reason the repository is shaped the way it
// is.
//
// The first: `src/index.ts` re-exports six namespaces, and the `Cafaye` class
// has to bind operations from those same six. Two `import * as identity from
// …` statements is a second place to update, and this repository is organised
// around there not being one — "`specs/` is the only place a service's OpenAPI
// path appears … That is the whole design: there is no second place to update,
// so there is no second place to forget." The imports live here; the public
// entrypoint and the class both come through them.
//
// The second: the SERVICE LIST. It cannot be derived — a static import is a
// static import — so it is stated three times in the source, in `services.ts`
// (the imports and the record), in `class.ts` (six typed properties, because a
// consumer's editor has to be able to complete `cafaye.` ) and in
// `openapi-ts.config.ts` (which, like everything else here, derives it from
// `specs/index.json` rather than keeping its own).
//
// Three statements of six names is one too many, and the mitigation is the same
// one this repository uses everywhere else: a test. `test/wrapper-services.test.mjs`
// asserts that this record's keys, the class's own properties and the six
// services in `specs/index.json` are the same six, in the same set. Adding a
// seventh service to the fleet therefore fails the suite in the place where the
// omission is, rather than producing a six-of-seven client that reports success.
//
// WHAT IS IN HERE, AND WHAT IS NOT
//
// The namespaces are the generated ones, unmodified. `AGENTS.md`: "Never
// hand-edit anything under `src/services/`. Every file there carries a `DO NOT
// EDIT` header naming the document and the commit it came from, and
// regeneration reverts whatever you write into it." Nothing in this file
// modifies them; `class.ts` wraps them from the outside, which is the whole
// reason MD6's structure has a hand-written half.

import * as identityClient from '../services/identity/client/index.js';
import * as billingClient from '../services/billing/client/index.js';
import * as courierClient from '../services/courier/client/index.js';
import * as darkroomClient from '../services/darkroom/client/index.js';
import * as museClient from '../services/muse/client/index.js';
import * as pantryClient from '../services/pantry/client/index.js';

import * as identity from '../services/identity/index.js';
import * as billing from '../services/billing/index.js';
import * as courier from '../services/courier/index.js';
import * as darkroom from '../services/darkroom/index.js';
import * as muse from '../services/muse/index.js';
import * as pantry from '../services/pantry/index.js';

/** One of the six services, as a name. */
export type ServiceName = 'identity' | 'billing' | 'muse' | 'darkroom' | 'pantry' | 'courier';

/**
 * The six generated namespaces, unaltered.
 *
 * `as const` so `ServiceName` and the record cannot drift: the union above is
 * `keyof typeof namespaces`, so adding a seventh key here is a compile error
 * everywhere the six are enumerated rather than a silent extra.
 */
export const namespaces = {
  identity,
  billing,
  courier,
  darkroom,
  muse,
  pantry,
} as const;

/**
 * The same six, as named exports, so `src/index.ts` is a list of names rather
 * than six `import * as` statements of its own.
 */
export { identity, billing, courier, darkroom, muse, pantry };

/**
 * The six names, for callers that need to enumerate.
 *
 * Derived, not written out. A consumer building a health check over the fleet
 * should not have to keep a list of six strings next to the six services, and a
 * `readonly` array of the six would be exactly that.
 */
export const serviceNames: readonly ServiceName[] = Object.freeze(
  Object.keys(namespaces) as ServiceName[],
);

/**
 * The generated `createClient` for each service.
 *
 * Six factories with six nominally distinct — and structurally near-identical —
 * return types, because each was generated into its own directory from its own
 * document. `class.ts` calls through this record and casts once, in one place,
 * rather than pretending the six are one type; the alternative is six copies of
 * the same four lines, which is the shape of drift.
 */
export const clientFactories = {
  identity: identityClient.createClient,
  billing: billingClient.createClient,
  courier: courierClient.createClient,
  darkroom: darkroomClient.createClient,
  muse: museClient.createClient,
  pantry: pantryClient.createClient,
} as const;

/**
 * The generated client type for one service, as its own `createClient` states it.
 *
 * This is what `Cafaye.rawClient` hands back, so a caller reaching for a route
 * the documents do not describe gets the generated type for that service rather
 * than a structural approximation of it.
 */
export type ServiceClient<S extends ServiceName> = ReturnType<(typeof clientFactories)[S]>;
