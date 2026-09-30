# AGENTS.md

Conventions for `cafaye-ts`, the cafaye TypeScript client. Read this before
changing anything; the house rules in `moon/PLAN.md` §1 and §3 apply on top of
it, and `moon/DECISIONS.md` **MD6** is the ruling this repository implements.

## What this repository is

`cafaye-ts` is the **generated half** of the cafaye TypeScript client: types and
per-service transport for all six services, generated from the fleet's committed
OpenAPI documents, generated-and-committed, with zero runtime dependencies.

It is not the whole client. The hand-written `Cafaye` class that MD6 describes —
credential handling, base-URL resolution, RFC 9457 error mapping — is packet
`cafaye-ts-02` and is **not here**. See "What this repository does not own".

The shape follows MD6's structural ruling, and the reason is Backstage's
pattern for a concrete reason rather than a stylistic one: the fleet's documents
already contain **two different auth models** — `identity` issues an opaque
server-side session token, and everything else uses a JWKS-verified bearer JWT.
A generated client cannot hide that, so a hand-written one owns it. And
generated code staying an internal detail is what makes a generator upgrade
unable to break the public API. MD6 cites what the alternative costs: Stainless,
a commercial generator whose owner announced a wind-down on 2026-05-18 and left
every consumer holding a version range that no longer meant anything.

## Layout

```
openapi-ts.config.ts   the generator's configuration. Reads specs/index.json; holds no service list of its own
specs/index.json       PROVENANCE. repository, path, 40-char commit sha, sha256 and measured counts, per service
specs/<service>.yaml   the six vendored documents, verbatim copies, committed
scripts/lib/specs.mjs  the one implementation of "what a vendored document is" and how to measure it
scripts/vendor.mjs     re-vendor, at the recorded shas. One command, all six, atomic
scripts/generate.mjs   run the generator for every service in the index
scripts/verify-specs.mjs  check the documents against the index; write nothing
src/index.ts           the public entrypoint. Six namespaces. Deliberately thin
src/services/<name>/   GENERATED, COMMITTED. 16 files per service, 96 in total
test/                  five properties, plus the git-tracked assertion
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
changing, and the document belongs to a service repository, not to this one.

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
reintroduce a dependency without touching `package.json`.
`test/no-runtime-dependencies.test.mjs` walks the module graph with the real
TypeScript parser and fails on any specifier that is not relative or a builtin.

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

**`src/index.ts` composes nothing, and that is not an oversight.** It re-exports
six namespaces and holds no credentials, no base-URL resolution, no error
mapping, and no method that combines two services. All of that is
`cafaye-ts-02`'s, and MD6's reason for wanting a hand-written wrapper is
structural rather than aesthetic. Add nothing here that packet will own. The one
thing this file does own is namespacing by service, because type names collide
across documents — `Problem` alone appears in more than one — and a flat
re-export would make the collision an arbitrary choice.

**Tests are `.mjs` under `node --test`.** No test framework: the house
precedent is `docs`, and a package whose selling point is zero dependencies
should not need one to test itself. `--test-concurrency=1` is in `package.json`
and is load-bearing: `regeneration.test.mjs` and `hand-edit-is-reverted.test.mjs`
both write to `src/services/`, and running them in parallel would make each
fail for a reason that has nothing to do with the generator.

**`npm ci`, never `npm install`, in anything automated.** The pins are only real
pins if the lockfile is honoured, and `npm ci` fails when the lock and
`package.json` disagree rather than quietly rewriting it. That is how a lockfile
reaches master having drifted from the manifest it claims to describe.

## What a green run does not prove

Stated in the spirit of **MD5**, which is a standing practice and not a comment
in one file. A green suite here means the vendored bytes match `specs/index.json`
and the committed tree matches the pinned generator. It says **nothing** about
whether the recorded shas are still what those repositories are on `master`.
That is `npm run vendor -- --bump`, and it is a human decision. Re-read the
index's `commit` column before assuming this client matches what a service is
actually serving — `identity`'s is behind right now, on purpose, because a packet
adding scoped API token routes was in flight when this was built.

## Gates

```sh
bin/prime          # npm ci && npm run typecheck && npm test
```

All of it before a commit lands. `bin/prime` is the gate; `mise run prime` is
the same thing through mise. The order is install, typecheck, test, and the
typecheck is not decoration: `node --test` runs the `.mjs` suite and reports
green while the TypeScript this package ships has an error in it, because the
suite tests the pipeline and the pipeline does not compile its own output. The
type check is the only step that looks at all 96 generated files as TypeScript.

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

## What this repository does not own

- **The `Cafaye` class.** Credentials, base URLs, RFC 9457 error mapping, and any
  convenience method that composes services. Packet `cafaye-ts-02`. If it seems
  obviously necessary here, that is why that packet exists — and adding a piece
  of it is how the two packets conflict.
- **Publishing to npm.** The package is shaped for it and the tarball is
  asserted, but it is not published and the name is provisional; whether this
  publishes unscoped or under `@cafaye/*` belongs with whoever owns the npm
  organisation. See the `DECISION NEEDED` in `cafaye.yml`.
- **The documents themselves.** They belong to `identity`, `billing`, `muse`,
  `darkroom`, `pantry` and `courier`. This repository holds copies with
  provenance and never edits them.
- **Registration in pantry.** Not yet done, deliberately, and not this
  repository's to do. The worktree sits outside the `cafaye/` directory and
  pantry's drift test walks that directory in both directions, so this
  repository appearing there turns its gate red for an entirely correct reason.
  Registering it is a separate packet.
