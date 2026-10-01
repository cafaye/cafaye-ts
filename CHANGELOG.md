# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0: a minor bump may break the API. Every break is listed here with the
commit that caused it and the one line that changes to opt back in.

## [Unreleased]

### Changed

- **All six vendored documents re-copied at their current masters, and the client
  regenerated.** The client was describing services that had moved underneath it.
  Every entry in `specs/index.json` moved forward; five of the six documents
  changed bytes.

  | Service | Operations | Paths | Document version | |
  |---|---:|---:|---|---|
  | `identity` | 16 → **31** | 12 → **26** | 1.2.0 → **1.5.0** | fifteen new operations |
  | `courier` | 8 → **10** | 4 → **6** | 1.2.0 → **2.2.0** | `sendMessage`, `receiveResendReport` |
  | `billing` | 15 | 11 | 1.1.0 → **1.3.0** | |
  | `muse` | 1 | 1 | 1.0.0 → **1.1.0** | auth model moved |
  | `pantry` | 4 | 4 | 1.1.0 | |
  | `darkroom` | 9 | 7 | 1.0.0 | **sha256 unchanged — verified no drift** |

  `darkroom` is a result rather than a skip: its document is byte-identical at the
  new commit, so the recorded sha moved and the vendored file was not rewritten.
  That is the only honest reading available for a service whose document did not
  change.

  All six, not the two in the current launch set. **`muse` is the reason**: its
  auth moved from "the token is not verified" to a verified JWT that must
  additionally carry `completions:write` and an `account_id`, with a new 403. A
  client describing an unenforced auth model is a correctness problem in the
  artifact, and a caller generated from it writes code that gets 401s.

  The fifteen `identity` additions are the scoped API token surface
  (`listApiKeys`, `mintApiKey`, `revokeApiKey`, `introspectApiKey`), the account
  admin surface (`listAccountAuditLog`, `revokeAccountInvitation`,
  `revokeAccountInvitations`) and the self-service mail surface
  (`requestPasswordReset`, `confirmPasswordReset`, `requestEmailVerification`,
  `confirmEmailVerification`, `getEmailVerificationStatus`,
  `requestEmailChange`, `confirmEmailChangeCurrentAddress`,
  `confirmEmailChangeNewAddress`).

  Breaking for anyone who counted: `cafaye.identity` now has 31 operations rather
  than 16, `cafaye.courier` has 10 rather than 8, and both namespaces gained names
  that did not exist. No operation was removed or renamed, so no call site breaks;
  the fleet total moves from 53 to 70.

### Added

- **`test/spec-drift.test.mjs` — every vendored document is byte-for-byte what its
  service said AT THE COMMIT THIS REPOSITORY RECORDS, for all six services.** The
  gap it closes is the one that let a month of drift accumulate: the sha256 check
  proved the vendored bytes matched `specs/index.json`, and both of those were
  stale together, so nothing was ever red.

  - **The claim is about the recorded commit, never the working tree**, borrowed
    from `pantry/tests/recorded_copy.rs`. Pantry's earlier `tests/drift.rs`
    compared to the working tree, so merges in other repositories turned *its*
    gate red and were reported as pantry being broken. Here the same shape would
    be worse, because the vendored document is the artifact the generator reads.
    At a recorded ref, "a merge in `identity`" and "somebody edited
    `specs/identity.yaml`" become different failures and only the second is a
    defect here.
  - **A shallow clone that cannot resolve the recorded ref is a FAILURE reading
    "cannot verify", not a pass.** With no workspace at all the tests SKIP, loudly
    and through `t.skip()`, so `node --test` counts them in `# skipped` and not in
    `# pass` — which `gate.yml`'s `# skipped 0` proof then reads.
  - **Staleness is a report with a budget, not a gate.** The distance from each
    recorded commit to its service's published head prints on every run; more than
    **9 commits** behind fails with the command that closes it.
  - Provenance is compared by `owner/name`, not by URL string, so an HTTPS clone
    of the right repository is accepted while a fork is still refused.

- **`scripts/lib/workspace.mjs`** — where the six checkouts are and how to read a
  document out of one at a sha. Extracted because `scripts/vendor.mjs` and
  `test/spec-drift.test.mjs` both need it and two implementations is two answers;
  the drift test's whole claim is that it compared the bytes the vendor wrote.
  `scripts/vendor.mjs` now imports it, and the origin check it performed by exact
  URL string became an `owner/name` comparison here.

- **`npm run e2e:identity` (`scripts/e2e-identity.mjs`) — the regenerated client
  against a real `identity` and a real Postgres.** 41 assertions, no mock and no
  fixture: register, sign in, read the session back, mint a scoped API token,
  introspect it, list it, revoke it, and check identity's own RFC 9457 bodies
  become typed exceptions. Deliberately **not** in the gate — a suite needing a
  database and a running service is a suite nobody can run, and
  `test/suite-is-offline.test.mjs` exists to keep sockets out of CI. No dependency
  added: `psql` is invoked as a subprocess, because `dependencies` is `{}` and
  stays `{}`.

- **CI clones the six services before `bin/prime`.** Without it the drift test
  skips on every run and the check this packet is about never runs anywhere
  automated. Before it, because `$GITHUB_ENV` applies to later steps only. Not
  `--depth 1`, because a shallow clone cannot resolve a recorded commit that is
  not its tip and the drift test would correctly report "cannot verify" every
  time.

- **`test/suite-is-offline.test.mjs` grew a self-test, and it immediately found a
  hole.** Each of the six rules in that file is a claim about what cannot appear in
  a test file, and a claim only ever exercised by the absence of an offender is a
  sentence rather than a check. The new assertion runs fifteen real violation
  shapes past the rules and six pieces of prose the rules must *not* fire on.
  - The git rule excluded quotes between `git` and the subcommand, so
    `execFileSync("git", ["clone", url, dir])` — the shape
    `scripts/lib/workspace.mjs` uses — read as clean. `[^'"\n]` is now `[^\n]`.
  - The same rule had no left word boundary, so it matched the word
    "**legit**imately" in a comment in `spec-drift.test.mjs`. It is now `\bgit\b`.
  - The remote rule named only the subcommand form (`git remote get-url`), so this
    packet's own rewrite of `scripts/vendor.mjs` to `git config --get
    remote.origin.url` sailed past it. Both spellings are now covered.
  Widened, not weakened, and the false-positive half is asserted too, because a
  check that catches its own documentation is a check that gets disabled.

- **`the_fleet_declares_auth_in_a_shape_no_operation_honours`** in
  `test/vendored-specs.test.mjs` — the measurement behind the wrapper's
  unconditional credential attachment, computed off the six documents on every
  run. It used to be prose in `AGENTS.md` and in a comment in
  `wrapper-class.test.mjs`, reading "eleven identity operations and six courier
  ones"; it went stale when identity-08 landed while the sentence around it still
  read like a finding. A number inside a comment cannot fail.

- **`gate.yml` — the gate is declared rather than discovered, and the declaration
  is load-bearing.** core ships the format (`schemas/gate.schema.json`), the
  checker (`harness/gate_check.py`) and the reasoning (`docs/gate.md`); this
  repository now tells the truth about itself against it in one checked file:
  the command, the mise task, the entrypoint, what the gate needs from the
  machine, and the lines its own output must contain before "green" means
  anything. Two of the claims were measured rather than assumed, and the first
  one changed the declaration.
  - **The declared command is `mise run prime`, not `bin/prime`, because
    `bin/prime` is green on a node this repository forbids.** Measured here, on
    node 22.12.0 — the version mise activates one directory up, and an ordinary
    thing to have on PATH: `./bin/prime` exits 0 with 187 passing tests. npm
    prints `EBADENGINE` for this package and for all five `@hey-api` packages
    and nothing fails, because neither `engines.node: ">=22.19.0"` nor
    `@hey-api/openapi-ts`'s own `>=22.18.0` is enforced by `npm ci`. Both are
    warnings. `mise run prime` applies the pin from `mise.toml`, which is what
    makes the toolchain requirement load-bearing instead of decorative.
  - **Three proofs, because the log is not equally informative about all three
    steps.** `# pass 201` is the decrease-detector and the floor, raised from 187
    by this packet. `# skipped 0` is separate because a test rewritten as `.skip`
    raises `# tests` and leaves `# pass` alone — measured, not imagined — so the
    count a reader scans moves while the count the floor reads does not; and it
    now carries more weight, because `spec-drift.test.mjs` is the first test here
    that can skip on a healthy machine. And `tsc --noEmit` prints **nothing** on
    success, so `==> npm test` is the only line in the whole log that is evidence
    the frozen install and the type check over the 96 generated files both
    succeeded.
  - **`selfContained: false`, with two requirements and each one's `unmet`
    observed rather than predicted.** node 22.19.0, and the npm registry or an
    npm cache already holding the tree — `npm ci` reinstalls the lockfile from
    scratch on every run, so this one is not "once, on a cold checkout" the way
    core's PyPI requirement is. No database, no running service, no credential.
    `test/suite-is-offline.test.mjs` keeps the *suite* offline and that is
    still true; `npm ci` runs before any test does, so the offline suite does not
    make the gate offline.
  - **`test/gate_self_test.sh` (`mise run gate-self-test`) is the proof that the
    proof works.** It copies the repository thirteen times, breaks exactly one
    thing in each, and asserts core's checker goes red *and names the finding the
    case was written for* — after a control on the unmodified copy, because
    thirteen reds against a repository that was already red prove nothing. Twelve
    are string comparisons. The thirteenth is the one that matters: pointing
    `npm test` at a glob that matches no file prints `# pass 0` and **exits 0**,
    which is the cafaye-rb defect reproduced in TypeScript, and the floor is the
    only thing standing between it and a green badge. It is not part of
    `bin/prime` — the gate runs the checker, the checker runs the gate, and a
    gate that verifies itself by running itself terminates — and it exits **2**
    rather than skipping when it cannot find a core checkout.

- **`Cafaye` — the hand-written client, and the whole integration is now four
  lines.** `new Cafaye({ baseUrl })` gives you `cafaye.identity.getCurrentUser()`
  and its five siblings, and the return value is the operation's **data** rather
  than the generated `{ data, error }` envelope. MD6 ruled the structure — "a
  single hand-written `Cafaye` class owns credential handling, base-URL resolution
  for self-hosting, and RFC 9457 problem-to-exception mapping. Generated code
  stays an implementation detail, so a generator upgrade can never break the
  public API" — and this is that class. No new runtime dependency: `atob`,
  `AbortController`, `setTimeout` and `URL` are all it uses.
- **Base-URL resolution, in a documented order, with no default.** `baseUrl` as a
  record, `baseUrl` as a string, `CAFAYE_<SERVICE>_BASE_URL`, `CAFAYE_BASE_URL`,
  the host's own origin — and then a `CafayeConfigurationError` that names every
  source it consulted and suggests no host. There is no loopback fallback and no
  reach for the generated clients' documented SaaS default; a self-hoster's
  traffic cannot end up somewhere nobody chose. All six are resolved in the
  constructor, so a partial record is a construction-time error naming the
  service. The per-service variable name is derived from the service name rather
  than written out six times.
- **Credential handling for all three shapes the fleet mints, chosen by the
  value rather than by the call site.** A `cafaye_`-prefixed scoped API token
  goes out as `Authorization: Bearer …` and nothing else; a session token goes out
  as that header **and** as `Cookie: __Host-session=…`, because identity accepts
  either and states that it prefers the header when both are present; a JWS goes
  out as the header alone, because core says cookies are for browser sessions and
  a misclassified JWT would publish a fleet-wide credential onto that surface.
  The `cafaye_` prefix is identity's own discriminator and this package reads it
  rather than inventing one. `setCredentials` replaces one on a live client, and
  a value that could break a header is refused at construction.
- **RFC 9457 problem-to-exception mapping: a typed hierarchy with a typed
  fallback.** `CafayeProblemError` and six subclasses for the cases worth
  catching — unauthenticated, forbidden, not found, rate limited, conflict (with
  `idempotency_key_reused` as a subclass of it), and validation with its
  per-field failures — plus `CafayeProtocolError` for a response that is not what
  the contract says, `CafayeNetworkError` and `CafayeTimeoutError` for anything
  that produced no response, and `CafayeConfigurationError` for a mistake made
  before a request existed. An unrecognised problem code produces a
  `CafayeProblemError` carrying that code, not a bare `Error`.
  `isCafayeError` also recognises an error from a second copy of this package,
  which `instanceof` does not.
- **A deadline per request, thirty seconds by default.** Typed as a
  `CafayeTimeoutError` with a `reason`, so a timeout is catchable as itself and
  as a network failure, and is not confusable with a DNS failure or with the
  caller's own abort. The timer is unref'd, so it cannot hold a Node process open,
  and is cleared when the request finishes.
- **One documented escape hatch, `cafaye.rawClient(service)`.** A service's own
  generated client, with this class's base URL and credential already on it, for a
  route the documents do not describe. Named so its cost is visible: errors from
  it are the generated envelope, not typed exceptions.
- **Seven test files and 121 new assertions, and four defects they found.** The
  notable one: this class emitted nothing at all, and that is now a tested
  property rather than an intention — every console method and both streams are
  captured across all seven code paths, `src/cafaye/` is scanned for a console
  call or a telemetry call with comments stripped, and a service that
  deliberately echoes your token back at you is proved unable to get it into an
  exception's message, stack, `cause` chain, own properties or serialised form.

### Changed

- **`src/index.ts` now exports the wrapper as well as the six namespaces.** The
  namespaces are still there and are still the raw transport; the README is
  rewritten around the two, with the wrapper as the front door and the generated
  client as the alternative, and says why the choice is not arbitrary.
- **The README's "there is no `Cafaye` class in this package yet" is gone**, and
  the test that asserted it now asserts the opposite: that the wrapper is
  documented, that the escape hatch is named, and that the base-URL table offers
  no loopback address. Three further defects in that test's own machinery were
  fixed on the way — it could not parse a multi-line import, it skipped every
  capitalised name as a type (so it skipped `Cafaye`), and it deduplicated
  hoisted imports by text rather than by binding.
- **`AGENTS.md` records the rules the hand-written half has**, each with the
  measurement or the failure that established it: no logging, all-or-nothing
  redaction, no base-URL default, identity's prefix as the discriminator,
  unconditional credential attachment (four of six services declare no
  per-operation `security`, and a client that respected the arrays would send
  unauthenticated requests to all four), owning the `AbortController` rather than
  using `AbortSignal.any`, and the three places the six service names are stated
  with the test that keeps them honest.

### Deliberately not built

- **No convenience method that composes two services**, no pagination helper, no
  token refresh, no retry, no cache, and no runtime validation of service
  responses. Each is a place to put a policy the platform should own, and MD6
  named four responsibilities for this class. A client that validates responses
  would need a runtime schema library and a dependency tree, which MD6 rules out.
- **No telemetry, and none planned.** Instrument the `fetch` you pass in.
- **No re-vendoring of `identity`.** The scoped API token routes landed in
  `bff6333` and the vendored copy is at `35c2576`, so this client has no typed
  `createApiKey` even though it reads the credential shape identity mints. The
  provenance is not this packet's to move.

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
