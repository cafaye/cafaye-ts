# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0: a minor bump may break the API. Every break is listed here with the
commit that caused it and the one line that changes to opt back in.

## [Unreleased]

## [0.1.0] — 2026-09-30

The first packet in a repository that was an empty scaffold, and it is
deliberately half a client. It is the generated half: types and per-service
transport for all six services, generated from the fleet's committed OpenAPI
documents and committed. It is not the `Cafaye` class, and its absence is the
point — see "Deliberately not built" at the bottom.

Implements `moon/DECISIONS.md` **MD6**.

### Added

- **Six generated service clients — 53 operations.**
  `identity` (16 operations, 12 paths), `billing` (15, 11), `muse` (1, 1),
  `darkroom` (9, 7), `pantry` (4, 4), `courier` (8, 4). All six documents are
  OpenAPI 3.1.0. Each service is a namespace, reachable either as
  `import { identity } from 'cafaye-ts'` or as
  `import { createClient } from 'cafaye-ts/services/identity'`.
- **The specification's prose, in every editor's autocomplete.** MD6's claim was
  that generation preserves a document's descriptions for free; it does. The
  argument for an argon2id password's minimum length, the note that `/healthz`
  is unconditional, and the reasons courier's notification-preference routes are
  unauthenticated are all in the emitted JSDoc, because they were in the
  documents.
- **`specs/*.yaml` — the six documents, vendored, committed, with provenance.**
  Each is a verbatim copy of a file in a service repository, recorded in
  `specs/index.json` against its source repository, its path within that
  repository, the full 40-character commit sha it was taken at, the sha256 of the
  bytes vendored, and its measured operation and path counts. The index ships
  inside the tarball, so a consumer can trace what they installed.
- **`npm run vendor` — re-vendoring as one command.** Resolves all six documents
  with `git cat-file -p <commit>:<path>` at their recorded shas, measures each,
  and only then writes. A failure part-way through is impossible by ordering
  rather than by rollback, because there is no transaction available across six
  file writes and a git call each. `--bump` moves every entry to its
  repository's current `master` first; that is the command to run when
  identity's document lands.
- **`npm run generate` — the generation pipeline.** Reads `specs/index.json`, so
  the service list exists in exactly one place and cannot drift from the
  provenance record. `openapi-ts.config.ts` holds no list of its own.
- **Five properties as tests, not as README claims.**
  Regeneration is byte-identical and committed; the package has no runtime
  dependencies; the published tarball contains no tests and no tooling; every
  vendored document is the one the index claims and declares operations; and a
  hand-edited generated file is reverted by regeneration. A sixth asserts that
  the generated tree is tracked by git, which is the assertion that catches a
  `.gitignore` entry silently turning "committed generated code" into "generated
  at install time".
- **`bin/prime`** — `npm ci`, `tsc --noEmit`, `npm test`. `npm ci` rather than
  `npm install`, so the lockfile is honoured and the two pins are real.

### Decisions

- **`@hey-api/openapi-ts` pinned to exactly `0.99.0`.** MD6's version is correct
  and was still npm's `latest` when this was built; no departure from MD6. Pinned
  without a caret, because a range on a code generator is a public API change
  waiting for a patch release.
- **`typescript` pinned to exactly `5.9.3`, and the pin is load-bearing.**
  Reproduced, not assumed: `@hey-api/openapi-ts@0.99.0` declares
  `peerDependencies: { typescript: ">=5.5.3 || >=6.0.0 || 6.0.1-rc" }`, and
  TypeScript 7.0.2 — published, and npm's `latest` — satisfies it. With 7.0.2
  installed the generator crashes **at module load**, before reading a document,
  quoting the same error the upstream issue does:

      TypeError: Cannot read properties of undefined (reading 'AnyKeyword')
        at node_modules/@hey-api/openapi-ts/dist/init-D6Y8JFUS.mjs:4017:21

  This is upstream [hey-api/hey-api#4235](https://github.com/hey-api/hey-api/issues/4235),
  "TypeScript 7 support (solution)": open at time of writing, labelled `bug` and
  `important`, 32 thumbs up, last activity 2026-09-18. The reporter is on 0.99.0
  and quotes the identical line number. A fix,
  [#4236](https://github.com/hey-api/hey-api/pull/4236), was opened the same day
  and **closed unmerged** on 2026-07-09 — so there is no released fix and MD6's
  "the fix is an open issue" is still accurate. The declared peer range does not
  exclude 7, so the range does not protect you. `npm run typecheck` and
  `test/no-runtime-dependencies.test.mjs` both fail loudly on a 7.x install.
- **`js-yaml` forced to `4.3.2` by an npm `override`, resolving five
  high-severity advisories without moving MD6's generator pin.** Versions
  4.0.0–4.3.1 carry prototype pollution in `<<` merge keys, quadratic-complexity
  denial of service in merge chains, and a CVE whose fix was never backported to
  4.x. The generator's own tree pulls a vulnerable 4.2.0, and `npm audit fix`
  cannot resolve it: its proposed remedy is downgrading `@hey-api/openapi-ts`,
  and even 0.97.0 remains inside the affected range. The override keeps the pin
  and reports `0 vulnerabilities`. Every one of these advisories is a
  **devDependency**; none reaches a consumer, which is the zero-dependency design
  doing the work it exists for.
- **`node` pinned to 22.19.0 in `mise.toml` and as `engines.node`.** It clears
  the generator's own `engines.node: ">=22.18.0"` and is the number `docs` pins,
  so one `mise install` serves both TypeScript repositories in the fleet.
  `typescript` is deliberately *not* also pinned in `mise.toml`: mise decides
  which compiler is on `PATH`, npm decides which one the generator imports, and
  only the second is the cliff MD6 describes.
- **The published tarball is `dist/`, not the source tree.** The generated code
  uses `.js` import specifiers, as `moduleResolution: NodeNext` requires, which
  means shipping raw TypeScript would produce a package that a bundler handles
  and plain Node cannot import. A client a self-hoster installs should not need a
  transpiler, so `npm run build` compiles the committed tree and `prepack` runs
  it — which means a stale `dist/` cannot be published. Verified by installing
  the packed tarball into a scratch project: `npm install` there pulls in exactly
  one package and no transitive dependencies, and plain `node` imports it with no
  transpiler.
- **Two entrypoints per service, and no pre-built client.** Operations and types
  are at `cafaye-ts/services/<name>`; `createClient` is at
  `cafaye-ts/services/<name>/client`. The generator also emits a module-level
  `client` const pre-pointed at each service's documented production URL, and it
  is deliberately not reachable from any entrypoint: a self-hoster who reached
  for it would send their traffic to the public SaaS. Adding `includeInEntry: true`
  to the client plugin would have put that shared mutable singleton on the public
  surface; it was tried and reverted, and the reasoning is in
  `openapi-ts.config.ts`.
- **The README's examples are executed, and two of them were wrong.** Found by
  installing the packed tarball into a scratch project and importing it, and by
  compiling the snippets — not by reading the emitter's output, which looks
  perfectly plausible either way. `import { createClient } from
  'cafaye-ts/services/identity'` does not resolve, and `const user: User = await
  getCurrentUser({ client })` does not compile, because the generated transport
  returns a result envelope rather than a bare value.
  `test/readme-examples.test.mjs` now imports every documented specifier against
  the built package and compiles the snippets with the project's own settings.
  Both bugs are proven caught: reinstating either turns the suite red with the
  compiler's own diagnostic.
- **No source maps in the tarball.** They would point at `.ts` files that are not
  in the tarball, so they would resolve to nothing for every consumer. The
  sources are in the repository, at the commit each generated file's header names.
- **`exactOptionalPropertyTypes` is off, deliberately, with the reason recorded in
  `tsconfig.json`.** The generator's emitted fetch client passes a `T | undefined`
  into a parameter typed `T`, in all six services. The generated tree cannot be
  hand-edited — that is the property this package exists to keep — so a strict
  flag the generated code cannot satisfy cannot be part of the package's
  compilation contract. Every other strict flag stays on, and
  `npm run typecheck` still compiles all 96 generated files.

### Notes for whoever reads this next

- **`identity`'s vendored document is behind on purpose.** A packet was in flight
  adding scoped API token routes to identity when this was built, so
  `specs/index.json` records a commit that predates them. That is expected and is
  not a failure; it is the reason `npm run vendor -- --service identity --bump`
  is one command and regeneration is a clean no-op.
- **`courier`'s document is at its repository root**, `openapi.yaml`, not at
  `openapi/v1.yaml` like the other five. The path per service lives in
  `specs/index.json` and nowhere else for exactly this reason, and a test states
  it on its own so that a future tidy-up that regularises the six paths trips
  something with a sentence explaining why it must not.

### Deliberately not built

- **The `Cafaye` class.** No credential handling, no base-URL resolution, no
  RFC 9457 problem-to-exception mapping, and no convenience method that composes
  two services. All of that is the next packet. MD6's reason for a hand-written
  wrapper is structural, and it is worth restating here because this package is
  the half that made it necessary: the fleet has two authentication models, a
  generated client cannot hide that, and generated code staying an internal
  detail is what stops a generator upgrade from breaking the public API.
- **Publishing to npm.** The package is shaped for it — `files`, `exports`,
  `prepack` — and `test/package-contents.test.mjs` asserts what npm would ship.
  It has not been published, and the name `cafaye-ts` is provisional: whether
  this publishes unscoped or under a `@cafaye/*` scope is a decision that
  belongs with whoever owns the npm organisation, not with this packet.
- **Any change to another repository.** In particular, `cafaye-ts` is not
  registered in `pantry`'s registry. This worktree sits outside the `cafaye/`
  directory, and `pantry`'s drift test walks that directory in both directions,
  so this repository appearing there turns its gate red for an entirely correct
  reason. Registering it is a separate packet and is not this one's to take.
