# AGENTS.md

Conventions for `cafaye-ts`, the cafaye TypeScript client. Read this before
changing anything; the house rules in `moon/PLAN.md` §1 and §3 apply on top of
it, and `moon/DECISIONS.md` **MD6** is the ruling this repository implements.

## What this repository is

`cafaye-ts` is the cafaye TypeScript client: **generated types and per-service
transport for all six services**, plus **one hand-written class** over the top of
it, with zero runtime dependencies.

The two halves are separate on purpose. MD6 ruled the structure — "generated
types and per-service transport, wrapped by one hand-written client … Generated
code stays an implementation detail, so a generator upgrade can never break the
public API" — and the reason is concrete rather than stylistic: the fleet's
documents already contain **two different auth models** — `identity` issues an
opaque server-side session token, and everything else uses a JWKS-verified bearer
JWT — plus a third credential shape from identity-08. A generated client cannot
hide that, so a hand-written one owns it. MD6 cites what the alternative costs:
Stainless, a commercial generator whose owner announced a wind-down on 2026-05-18
and left every consumer holding a version range that no longer meant anything.

## Layout

```
openapi-ts.config.ts   the generator's configuration. Reads specs/index.json; holds no service list of its own
specs/index.json       PROVENANCE. repository, path, 40-char commit sha, sha256 and measured counts, per service
specs/<service>.yaml   the six vendored documents, verbatim copies, committed
scripts/lib/specs.mjs  the one implementation of "what a vendored document is" and how to measure it
scripts/vendor.mjs     re-vendor, at the recorded shas. One command, all six, atomic
scripts/generate.mjs   run the generator for every service in the index
scripts/verify-specs.mjs  check the documents against the index; write nothing
src/index.ts           the public entrypoint: Cafaye, the error types, the six namespaces
src/cafaye/class.ts    THE HAND-WRITTEN CLIENT. Credentials, deadlines, error mapping
src/cafaye/base-url.ts where requests go, in a documented order, with no default
src/cafaye/credentials.ts  which credential this is, and where it may be sent
src/cafaye/errors.ts   the RFC 9457 exception hierarchy
src/cafaye/redact.ts   the scrubber, and safeCause
src/cafaye/services.ts the six generated namespaces, imported exactly once
src/services/<name>/   GENERATED, COMMITTED. 16 files per service, 96 in total
test/                  five properties, the README's examples, and seven wrapper files
bin/prime              the gate: npm ci, typecheck, the full test suite
```

`specs/` is the only place a service's OpenAPI path appears, and
`openapi-ts.config.ts` derives its service list from `specs/index.json`. Neither
file knows the list independently. That is the whole design: there is no second
place to update, so there is no second place to forget.

## Rules

**Never hand-edit anything under `src/services/`.** Every file there carries a
`DO NOT EDIT` header naming the document and the commit it came from, and
regeneration reverts whatever you write into it.
`test/hand-edit-is-reverted.test.mjs` proves it by making the edit and asserting
it is undone. If you think a generated file needs changing, the document needs
changing, and the document belongs to a service repository, not to this one. The
answer to "the generated code does not offer what I need" is to **wrap** it from
`src/cafaye/`, never to edit it.

**The generated tree is committed, and `.gitignore` must never stop it.** This
is the mistake with the longest fuse in the repository. A `.gitignore` entry for
`src/services/` turns "generated from the spec and committed" into "generated at
install time" without any error, and the only symptom is that
`git diff --exit-code` starts passing **vacuously** over a tree it can no longer
see — an untracked directory has no diff. Two tests exist for exactly this, and
one of them deliberately hides the tree from git to prove the hazard is real:
`test/hand-edit-is-reverted.test.mjs` and `test/regeneration.test.mjs`.

**Generation is a deliberate, reviewed act.** You run it, you read the diff, you
commit it. You do not run it in `prepare`, `postinstall`, or `prepublishOnly`
within a service, and nothing in a consumer's install regenerates anything. The
whole self-hostable constraint rests on this: a client installs from npm with no
git clones and no reachable remotes.

**The six documents are vendored, committed, and carry provenance.** Each entry
in `specs/index.json` records the source repository, the path within it, the
**full 40-character commit sha** the copy was taken at, the sha256 of the bytes
that were vendored, and the measured operation and path counts. `npm run vendor`
reads every document with `git cat-file -p <commit>:<path>` — **never from a
working tree** — and resolves all six before writing any, so a partial update is
impossible by ordering rather than by rollback. Do not shorten a sha. An
abbreviated sha is what every terminal prints by default and it cannot be
resolved by anything.

**`courier`'s document is at its repository root.** `openapi.yaml`, not
`openapi/v1.yaml` like the other five. A loop that assumed the conventional path
would have skipped courier and produced a five-of-six client that reported
success. This is MD6's own lesson — its first measurement used a glob matching
files *named* `openapi*`, missed every document under `openapi/`, and had to be
corrected. `test/vendored-specs.test.mjs` states courier's path on its own so a
future tidy-up that regularises the six trips a test carrying the reason.

**The two pins are load-bearing, and both are exact.**

- `@hey-api/openapi-ts` is pinned to an exact version, no caret. A range on a
  code generator is a public API change waiting for a patch release.
- `typescript` is pinned to an exact 5.x for a sharper reason. TypeScript 7
  removed a compiler API the generator's transformers use. The generator declares
  `peerDependencies: { typescript: ">=5.5.3 || >=6.0.0" }`, and TypeScript 7.0.2
  — npm's `latest` — **satisfies that range**. With it installed the generator
  does not warn and does not degrade; it crashes at module load, before reading a
  document:

      TypeError: Cannot read properties of undefined (reading 'AnyKeyword')
        at node_modules/@hey-api/openapi-ts/dist/init-*.mjs:4017:21

  This is not a local misconfiguration. It is upstream
  [hey-api/hey-api#4235](https://github.com/hey-api/hey-api/issues/4235), "TypeScript
  7 support (solution)": open, labelled `bug` and `important`, 32 thumbs up, last
  activity 2026-09-18. The reporter is on 0.99.0 — our version — and quotes the
  identical error and the identical line number. A fix was proposed the same day
  as [#4236](https://github.com/hey-api/hey-api/pull/4236), "fix(openapi-ts):
  support TypeScript 7 consumers", and it was **closed unmerged** on 2026-07-09,
  so there is no released fix. Re-check both before moving the pin, and re-check
  whether a newer generator has shipped one.

  The declared peer range does not protect you. Only the pin does. Never run
  `npm install typescript`; change the pin deliberately, expect a regeneration
  diff, and read it.

**`dependencies` is `{}` and stays `{}`.** MD6 requires zero, for a reason about
self-hosting rather than bundle size: a self-hoster who installs this should be
able to read one file and know exactly what arrived. A dependency tree is an
audit they have to delegate, and a transitive one is an audit nobody can do.
The generated transport runs on the platform's `fetch` because
`@hey-api/client-fetch` makes the generator **copy** the client into the output
rather than import a package — switching clients in `openapi-ts.config.ts` would
reintroduce a dependency without touching `package.json`. The hand-written half
adds none either: `atob` and `JSON.parse` classify a JWS, `AbortController` and
`setTimeout` install a deadline, and `URL` parses a base URL.
`test/no-runtime-dependencies.test.mjs` walks the module graph with the real
TypeScript parser and fails on any specifier that is not relative or a builtin.
**The wrapper is the thing a consumer does not have to configure; a dependency
tree is a configuration surface**, so adding one is a decision to record here and
in the report, never a detail of a diff.

**Development tooling belongs in `devDependencies`, and the tarball proves it.**
`test/package-contents.test.mjs` runs `npm pack --dry-run` and asserts the file
list: no `test/`, no `scripts/`, no `tsconfig`, no `.github/`, no `bin/`, no
source maps. `scripts/vendor.mjs` is the sharpest one — it contains six
`git@github.com:cafaye/…` remotes, and shipping it would tell every consumer
this package expects to sit next to six git clones. It also asserts the
*positives*, which matter more: all six services present, declarations present,
and `specs/index.json` present.

**The published tarball is `dist/`, built by `prepack`.** The generated code uses
`.js` import specifiers, as `moduleResolution: NodeNext` requires, so shipping
raw TypeScript would produce a package a bundler handles and plain Node cannot
import. A client a self-hoster installs should not need a transpiler.
`prepack` runs the build, so a stale `dist/` cannot be published. No source maps:
they would point at `.ts` files that are not in the tarball.

**Tests are `.mjs` under `node --test`.** No test framework: the house
precedent is `docs`, and a package whose selling point is zero dependencies
should not need one to test itself. `--test-concurrency=1` is in `package.json`
and is load-bearing: `regeneration.test.mjs` and `hand-edit-is-reverted.test.mjs`
both write to `src/services/`, and running them in parallel would make each
fail for a reason that has nothing to do with the generator.

**Wrapper tests import `dist/`, through `test/lib/dist.mjs`.** `src/` is
TypeScript and cannot be imported by `node --test`, and `src/` is not what a
consumer installs. `loadDist()` builds on demand, so any wrapper test file runs
on its own without depending on `package-contents.test.mjs` having built `dist/`
first — which was a real fragility in the one test that already assumed it.

**`npm ci`, never `npm install`, in anything automated.** The pins are only real
pins if the lockfile is honoured, and `npm ci` fails when the lock and
`package.json` disagree rather than quietly rewriting it. That is how a lockfile
reaches master having drifted from the manifest it claims to describe.

## Rules for the hand-written half

**Never log. Not at any level, not behind an option, not to a stream.** This
package is the one place in a consumer's application that touches every credential
it has, and `error.message` reaches a log file, a crash reporter, a support
ticket and somebody's screen with no configuration. Emitting nothing is the only
way to guarantee that for a library: a debug log is a log level somebody disables
in production and pastes into a bug report.
`test/wrapper-credential-leak.test.mjs` captures every console method and both
streams across all seven paths, and separately scans `src/cafaye/` for a console
call, a stream write or a telemetry call with comments stripped.

**Everything a service, a header, a platform error or a caller supplies goes
through `createRedactor`, and the redactor is all or nothing.** A string comes
back whole or comes back as `[redacted: a credential-shaped value was present]`.
There is no partial redaction, and the reason is that a scrubber which removes
what it recognises and returns the rest invites a reader to add one more
pattern — and the day that pattern has a gap is the day a credential ships. A
partially-scrubbed `cause` is the same mistake one level out, so `safeCause`
withholds the original platform error **entirely** when there is anything to
withhold, keeping `name` and `code` because those are enums and are what a
handler branches on. The errno is also recorded on the error itself, so
withholding a cause never costs the caller the one thing they needed.

**Resolution of the base URL has no default, and never falls back to a loopback
address.** `resolveBaseUrl` consults, in order: `baseUrl[service]`, `baseUrl` as
a string, `CAFAYE_<SERVICE>_BASE_URL`, `CAFAYE_BASE_URL`,
`globalThis.location.origin` — and then **throws**, naming every source it
consulted and suggesting no host. The generated clients each carry a documented
default pointing at the public SaaS, and a loopback default would be the same
failure in friendlier clothes. `Cafaye` resolves all six in its constructor, so a
partial `baseUrl` record is a construction-time error naming the service rather
than a surprise on the fifth call. `CAFAYE_<SERVICE>_BASE_URL` is **derived** from
the service name by `baseUrlEnvFor`; six string literals would be a second list of
the six services.

**`cafaye_` is identity's discriminator, and this package reads it rather than
inventing one.** `internal/httpapi/apikeys.go` states the reason: the api_keys and
sessions tables are different tables with different lifetimes and different
revocation stories, and the prefix decides which is consulted without a query.
Anything that is not a `cafaye_` token and not a JWS is a session token, and a
session is the **only** shape that travels in a `Cookie` header — core says "No
cookies for API traffic; browser sessions use … cookies and a CSRF token, and
those are a *different* surface". A JWT misread as a session would publish a
fleet-wide credential onto the browser surface, which is why the three-way split
is not two.

**The credential attaches to every request, unconditionally.** The obvious
refinement is to attach it only where the document declares a security scheme,
and it is measurably wrong for this fleet: `grep` over the six vendored documents
finds per-operation `security` arrays on eleven identity operations and six
courier ones, and **none** on billing, muse, darkroom or pantry — muse and
darkroom state theirs globally, which the generator does not copy onto each
operation, and billing and pantry state `security: []` with a note. A client that
respected the arrays would send unauthenticated requests to four of six services
and the failure would be a 401 from a service rather than an error from the
client. The measurement is written into the test that depends on it.

**The class owns the `AbortController`, not `AbortSignal.any`.** `any` adopts the
reason from whichever signal fired, so a caller who aborts with an error of their
own — the documented way to say why they stopped — produces a rejection that
cannot be classified, because an arbitrary `Error` is indistinguishable from a
network failure. The caller's side aborts with a sentinel the class recognises and
the deadline aborts with a `CafayeTimeoutError`, so both arrive already typed.
The deadline is a `setTimeout` and not `AbortSignal.timeout`, because the
platform's version uses an internal timer that no test clock can reach — writing
the test and watching the event loop drain past a pending deadline is what found
it. `node:test`'s mock timers drive it, so a thirty-second timeout costs no
thirty seconds. It is **unref'd**, so a pending deadline cannot hold a process
open, and cleared on completion through a `WeakMap` keyed by the signal.

**A response interceptor must return its first argument.** The generated
transport assigns the hook's result back over the response
(`response = await fn(response, request, opts)`), so a hook returning `undefined`
silently replaces a good response with nothing. That is not hypothetical: the
first version of the cleanup interceptor did it, and every request in the suite
failed as `the request failed: [object Object]`.

**`BoundOperation` is load-bearing and subtle; `test/wrapper-types.test.mjs` is
what keeps it honest.** Inferring a signature from outside erases `ThrowOnError`
to its **constraint**, not its default, and `boolean extends true ? … : …` then
distributes into BOTH the throwing and the envelope branch. `DataOf` must
distribute for the union to collapse, optionality is read with
`[undefined] extends [O]` (the other direction is also true for a required
parameter under `noUncheckedIndexedAccess`, which this repository turns on), and
the `Promise` has to be unwrapped. A runtime test cannot see any of this: a
signature that returns `any` passes every behavioural assertion there is. The
probe in `wrapper-types.test.mjs` compiles a file that uses the wrapper as a
consumer would, through the package name, so it checks the declarations a
consumer actually installs.

**The six service names are stated three times in the source**, because a static
import is a static import and a consumer's editor needs real properties to
complete: in `services.ts` (the imports and the record), in `class.ts` (six typed
properties) and in `openapi-ts.config.ts` (which derives from
`specs/index.json`). Three statements of six names is one too many, and the
mitigation is the one this repository uses everywhere else: a test.
`test/wrapper-class.test.mjs` asserts that the record's keys, the class's own
properties and the six services in `specs/index.json` are the same six, so a
seventh service fails the suite in the place where the omission is rather than
producing a six-of-seven client that reports success. Same tripwire shape as
`regeneration.test.mjs` and as courier's document path.

**The wrapper composes nothing.** No convenience method that spans two services,
no pagination helper, no token refresh, no retry, no cache, no runtime response
validation. Each is a place to put a policy the platform should own, and putting
one here would make the fleet's current shape a thing a consumer's application
depends on. MD6 named four responsibilities — credentials, base URLs, RFC 9457
mapping, and being the public surface — and this class has those four. The one
deliberate exception is `rawClient(service)`, an escape hatch for a route the
documents do not describe, named so its cost is visible: **errors from it are not
typed**, because it hands back the generated envelope.

## What a green run does not prove

Stated in the spirit of **MD5**, which is a standing practice and not a comment
in one file. A green suite here means the vendored bytes match `specs/index.json`,
the committed tree matches the pinned generator, and the wrapper does what its
tests say. It says **nothing** about whether the recorded shas are still what
those repositories are on `master`. That is `npm run vendor -- --bump`, and it is
a human decision. Re-read the index's `commit` column before assuming this client
matches what a service is actually serving — `identity`'s is behind right now, on
purpose, and deliberately: the vendored copy is at `35c2576` and the scoped API
token routes landed in `bff6333`, which is why this client has no typed
`createApiKey` even though the credential shape it reads (`cafaye_` plus 32 bytes)
is the one identity mints. Re-vendoring is `cafaye-ts-03`'s decision, not this
class's, and the brief for this packet forbade touching the provenance.

It also says nothing about whether a **service** honours its own document. The
generated types come from the documents, so a service that drifts produces a
wrong value shaped like a right one, and no amount of type checking sees it.

## Gates

```sh
bin/prime          # npm ci && npm run typecheck && npm test
```

All of it before a commit lands. `bin/prime` is the gate; `mise run prime` is
the same thing through mise. The order is install, typecheck, test, and the
typecheck is not decoration: `node --test` runs the `.mjs` suite and reports
green while the TypeScript this package ships has an error in it, because the
suite tests the pipeline and the pipeline does not compile its own output. The
type check is the only step that looks at all 96 generated files — and the whole
of `src/cafaye/` — as TypeScript.

The current floor is **187 pass, 0 fail, 0 skipped**. cafaye-ts-01's baseline was
67; do not go below the current number, and do not fix a red test by loosening an
assertion, raising a retry or adding a sleep.

**No sleeps, no raised retries, no loosened assertions.** The deadline tests use
`node:test`'s mock timers and an injected `fetch`; the only `await` on a
macrotask anywhere is `setImmediate`, which is a yield rather than a wait and has
no interval to be late against. `test/suite-is-offline.test.mjs` is the standing
reason: a test that performs an HTTP request cannot run offline, and the vendored
bytes are the artifact.

## Changing a generated file's contents

You cannot. Change the document in the service repository that owns it, land
that, then:

1. `npm run vendor -- --bump --service <name>` — move that entry to the new
   commit, re-vendor, and update `expectOperations` **in the same commit** if the
   document's operation count moved. A count that moves without that edit fails
   the vendor, which is the intended behaviour: a document that changed size
   under the client is the event this provenance exists to catch.
2. `npm run generate` — regenerate.
3. Read the diff. It is the review.
4. `bin/prime` — regeneration must be a no-op afterwards, which is what proves
   the commit is the whole story.
5. CHANGELOG entry.

A regeneration diff can also change the **public** surface without changing the
generated files' contents — a new operation appears in a namespace, a type
changes shape — and `test/package-contents.test.mjs`'s count assertions and the
README's table are there to catch the drift. Read the README's operation table
after a bump; it is asserted against `specs/index.json`, not against the
generator.

## What this repository does not own

- **The documents themselves.** They belong to `identity`, `billing`, `muse`,
  `darkroom`, `pantry` and `courier`. This repository holds copies with
  provenance and never edits them. Re-vendoring `identity` onto `bff6333` is the
  obvious next packet and is deliberately not this one.
- **Publishing to npm.** The package is shaped for it and the tarball is
  asserted, but it is not published and the name is provisional; whether this
  publishes unscoped or under `@cafaye/*` belongs with whoever owns the npm
  organisation. See the `DECISION NEEDED` in `cafaye.yml`. The `core: ^0.2.0`
  range there is also still open and is left open.
- **Registration in pantry.** Not yet done, deliberately, and not this
  repository's to do. The worktree sits outside the `cafaye/` directory and
  pantry's drift test walks that directory in both directions, so this
  repository appearing there turns its gate red for an entirely correct reason.
  Registering it is a separate packet.
- **The scope claim's canonical name.** MD7 is open: identity mints tokens
  carrying both `scope` and `scopes` because core cannot yet settle which is
  canonical. This client does not read either — it forwards the credential
  without parsing it — so MD7 is invisible here, which is the right outcome and
  worth noticing: the ambiguity is contained inside the token.
