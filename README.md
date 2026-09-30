# cafaye-ts

**The cafaye TypeScript client. Types and per-service transport, generated from
the fleet's committed OpenAPI documents.**

This package is the generated half of the cafaye client. It gives you a typed
function per HTTP operation across all six services, and it gives them to you
with the specification's own prose attached, so your editor can tell you what an
endpoint is for without you leaving the code.

It has **no runtime dependencies**. It does not decide how you authenticate, what
base URL you point at, or what a `problem+json` response means — that is the
hand-written `Cafaye` class, which is not in this package yet. See
[What this is not](#what-this-is-not).

## Install

```sh
npm install cafaye-ts
```

Node 22.19 or newer. Nothing else — there is no `fetch` polyfill to install, no
HTTP client, and no dependency tree to audit. If you are self-hosting, your
runtime already has `fetch`.

## Use it

Every service is a namespace. Pick the one you want:

```ts
import { identity, billing } from 'cafaye-ts';

const client = identity.createClient({ baseUrl: 'https://identity.example.com' });

// The prose below is from identity's OpenAPI document, in your editor's hover.
const user = await identity.getCurrentUser({ client });
```

Or import one service directly, which is what you want if you are not using the
top-level entrypoint:

```ts
import { createClient, getCurrentUser } from 'cafaye-ts/services/identity';
import type { User } from 'cafaye-ts/services/identity';

const client = createClient({ baseUrl: 'https://identity.example.com' });
const user: User = await getCurrentUser({ client });
```

Both routes reach the same generated code. The subpath is the more stable of the
two, because the generator's internal file layout is only visible through it.

## What is in the box

| Service | Operations | Paths | Document version |
|---|---:|---:|---|
| `identity` | 16 | 12 | 1.2.0 |
| `billing` | 15 | 11 | 1.1.0 |
| `muse` | 1 | 1 | 1.0.0 |
| `darkroom` | 9 | 7 | 1.0.0 |
| `pantry` | 4 | 4 | 1.1.0 |
| `courier` | 8 | 4 | 1.2.0 |
| **total** | **53** | | |

All six documents are OpenAPI 3.1. The counts are measured from the documents
themselves and asserted by the test suite; if a service's document changes size,
this table and the suite change together or the suite fails.

For every operation you get a function and a family of types:

- `<operation>Data` — the request
- `<operation>Response` / `<operation>Responses` — the success shape, and every
  documented status code as a discriminated union
- `<operation>Error` / `<operation>Errors` — the documented failure shapes

## Provenance: where this came from

This package is built from six OpenAPI documents that live in six other
repositories. Copies of those documents are committed here, and
[`specs/index.json`](specs/index.json) records, for each one, the repository it
came from, the path within it, and the **full 40-character commit sha** it was
taken at. That file ships inside the tarball, so you can answer "is this client
built from the document that describes the service I am running, or from one that
has drifted?" about the package you actually installed — offline, without this
repository.

```json
{
  "service": "courier",
  "repository": "git@github.com:cafaye/courier.git",
  "path": "openapi.yaml",
  "commit": "59247b6c65fd86a331a4f4bdcaf180ee1730687f",
  "operations": 8,
  "sha256": "20e65fc7c638..."
}
```

A vendored document with no sha is a rumour. That is the whole reason the index
exists, and it is why the test suite refuses to pass if a vendored file's bytes
stop matching what the index says.

**Your copy of `identity` is behind.** A change to identity's OpenAPI document
was in flight when this package was built, and the vendored copy will be behind
the moment it lands. That is expected: this package is rebuilt from the
documents deliberately, by a human, in a reviewable diff — not continuously. If
you need identity's newest routes, check the `commit` above against your
deployed identity and wait for the next release, or build from source.

## What this is not

**There is no `Cafaye` class in this package yet.** The fleet has two different
authentication models — `identity` issues an opaque server-side session token,
and everything else uses a JWKS-verified bearer JWT — plus base-URL resolution
for self-hosting and RFC 9457 problem-to-exception mapping. A generated client
cannot hide that, so a hand-written one owns it. It is the next packet, and it
wraps what is here.

Until then, you construct a client yourself and you handle errors as whatever
the generated types say they are. If you were hoping for
`new Cafaye({ baseUrl, token })`, that is coming and it is not here yet.

**This is also not a wrapper you should build on.** `src/services/**` is
generated code, it carries a `DO NOT EDIT` header, and regeneration reverts
anything written into it. The top-level entrypoint is the surface, and it is
deliberately thin.

## Regenerating

If you are working in this repository rather than consuming the package:

```sh
mise install          # the pinned toolchain: node 22.19.0
bin/prime             # the gate: npm ci, typecheck, the full test suite
```

- `npm run vendor` — re-copy the six documents at the shas in `specs/index.json`.
  Produces a diff or no diff, never a partial update.
- `npm run vendor -- --bump` — move every entry to its repository's current
  `master` first. This is the command to run when a service's document changed.
- `npm run generate` — regenerate all six clients from the committed documents.

`npm test` re-runs the generation pipeline and fails if the result is not
byte-identical to what is committed. That is the property that makes "generated
from the spec" a fact rather than a claim, and it is what tells you when a
generator upgrade has changed the public surface.

## The two pins that are load-bearing

`@hey-api/openapi-ts` and `typescript` are both pinned to **exact** versions,
and both pins exist because of a reproduced failure rather than a caution.

- **`@hey-api/openapi-ts` is pinned exactly, with no caret.** A caret range on a
  code generator is a public API change waiting for a patch release. MD6 cites
  what that costs: Stainless, a commercial generator whose owner announced a
  wind-down on 2026-05-18 and left every consumer holding a version range that
  no longer meant anything.
- **`typescript` is pinned to 5.9.3, also exactly.** TypeScript 7 removed a
  compiler API the generator's transformers use. The generator declares
  `peerDependencies: { typescript: ">=5.5.3 || >=6.0.0" }`, and TypeScript
  7.0.2 — npm's current `latest` — *satisfies that range*. With it installed the
  generator does not warn and does not degrade; it crashes before reading a
  document. The declared peer range does not protect you. Only the pin does, and
  `test/no-runtime-dependencies.test.mjs` is its tripwire.

## License

MIT. See [LICENSE](LICENSE).
