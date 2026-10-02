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
scripts/lib/workspace.mjs  where the six checkouts are, and how to read a document out of one at a sha
scripts/lib/dist.mjs   load the BUILT package, the way a consumer loads it
scripts/lib/capability.mjs  what a customer must be able to DO through this client, and the four verdicts
scripts/vendor.mjs     re-vendor, at the recorded shas. One command, all six, atomic
scripts/generate.mjs   run the generator for every service in the index
scripts/capability.mjs `npm run capability` — the answer as a list, for a person rather than a gate log
scripts/verify-specs.mjs  check the documents against the index; write nothing
scripts/e2e-identity.mjs  drive a REAL identity against a REAL Postgres. Not in the gate
src/index.ts           the public entrypoint: Cafaye, the error types, the six namespaces
src/cafaye/class.ts    THE HAND-WRITTEN CLIENT. Credentials, deadlines, error mapping
src/cafaye/base-url.ts where requests go, in a documented order, with no default
src/cafaye/credentials.ts  which credential this is, and where it may be sent
src/cafaye/errors.ts   the RFC 9457 exception hierarchy
src/cafaye/redact.ts   the scrubber, and safeCause
src/cafaye/services.ts the six generated namespaces, imported exactly once
src/services/<name>/   GENERATED, COMMITTED. 16 files per service, 96 in total
test/                  five properties, the drift check, the customer's path, the README's examples, and seven wrapper files
bin/prime              the gate: npm ci, typecheck, the full test suite
```

`test/lib/dist.mjs` is a re-export of `scripts/lib/dist.mjs` and nothing else.
It stayed behind when the implementation moved — `scripts/capability.mjs` needs the
same built-package loader, and a script reaching into `test/` for its own loader
would make the test directory a library the shipped scripts depend on. Seven test
files import it and none of them changed, which is the point of leaving a
re-export rather than editing a call site seven times.

**What is in the customer path, and the two failures that are the finding.** See
"What a customer cannot do through this client" below. `bin/prime` is **red**,
deliberately, and the reasoning is written down in `gate.yml` next to the floor
that counts it.

`scripts/lib/workspace.mjs` exists because `scripts/vendor.mjs` and
`test/spec-drift.test.mjs` both need to know where the fleet is and how to read a
document out of it, and **two implementations is two answers**. The drift test's
entire claim is that it compared the bytes the vendor wrote; a second copy of the
workspace resolution would make that claim false in exactly the way this
repository's own header warns about. The vendor imports it and the test imports it
and neither owns it.

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

**The six documents are vendored, committed, and carry provenance, and the
provenance is CHECKED against the source — for all six, not the one you touched.**
Each entry in `specs/index.json` records the source repository, the path within
it, the **full 40-character commit sha** the copy was taken at, the sha256 of the
bytes that were vendored, and the measured operation and path counts. `npm run
vendor` reads every document with `git cat-file -p <commit>:<path>` — **never from
a working tree** — and resolves all six before writing any, so a partial update is
impossible by ordering rather than by rollback. Do not shorten a sha. An
abbreviated sha is what every terminal prints by default and it cannot be resolved
by anything.

`test/spec-drift.test.mjs` closes the loop `npm run vendor` opens: it asserts every
vendored document is byte-for-byte what `<repository>:<path>` said **at the
recorded commit**, read out of a local checkout with `git cat-file`. It covers all
six and it writes all six out itself rather than deriving them from the index,
because a drift test guarding only the service you happened to touch is the
one-consumer problem narrowed rather than fixed.

**The claim is about the recorded commit, never about the working tree.** That is
borrowed from `pantry/tests/recorded_copy.rs`, and it is borrowed because pantry
already paid for the other version: its `tests/drift.rs` compared against the
working tree, so `identity-09` and `muse-06` landing turned *pantry's* gate red in
a repository nobody had touched, and each red was reported as pantry being broken.
Here the same thing would be worse, because the vendored document is the artifact
the generator reads — a test comparing to the working tree goes red every time any
service merges, and every red is reported against `cafaye-ts`. The difference is
who a red belongs to: at a recorded ref, "a merge in `identity`" and "somebody
edited `specs/identity.yaml` here" become different failures, and only the second
is a defect in this repository.

**Three failure shapes, three different answers, and none of them is a pass.**

- no workspace at all → **skip**, loudly, naming every directory searched. A
  self-hoster installs this from npm with no sibling checkouts and the suite must
  still pass for them; `test/vendored-specs.test.mjs` is what proves it, entirely
  offline. The skip uses `t.skip()`, so `node --test` counts it in `# skipped` and
  **not** in `# pass`, and `gate.yml`'s `# skipped 0` proof goes red.
- workspace present, recorded ref absent → **fail**, "cannot verify", with the
  fix. This is the shallow-clone case, and it is the honest answer rather than a
  pass: a depth-limited history cannot resolve a recorded commit that is not its
  tip, and reporting that as six verifications is how a fleet comes to believe it
  is up to date because the thing that would have told it otherwise could not run.
- workspace present, ref readable, bytes differ → **fail**, naming the ref, both
  digests and the first differing line. Both causes are defects here: a
  hand-edited document, or a commit bumped without re-copying.

**Staleness is a REPORT with a budget, never a gate.** The distance from each
recorded commit to its service's published head prints on every run, and a copy
more than **9 commits** behind fails with the one command that closes it. Not
zero — zero is exactly the defect this replaces, a gate that goes red whenever
anybody merges. Not unbounded — unbounded is the "quiet and still wrong" it
replaces, where the document is accurate as of its recorded ref and nobody has been
told `identity` has merged fifteen times since. Nine is roughly a working day of
this fleet's merge rate, and the constant is a named `const` so moving it is a
visible diff rather than an edit to a number inside a sentence.

**Comparing two clones is by `owner/name`, not by URL string.** The index records
`git@github.com:cafaye/identity.git` because PLAN.md §1 makes SSH the house
remote, and a CI job or a self-hoster legitimately holds an HTTPS clone of the
same repository. `repositorySlug` in `scripts/lib/workspace.mjs` accepts both and
strips `.git`, because the check that matters is "is this the right repository" —
which catches a fork — and not "is this the right transport".

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
and it is measurably wrong for this fleet: four of the six documents have
operations whose auth **no generated operation can see**, because a
document-level `security` is not copied onto each operation. Measured over the
vendored documents on 2026-10-02, and computed on every test run rather than
written down, by `the_fleet_declares_auth_in_a_shape_no_operation_honours` in
`test/vendored-specs.test.mjs`:

```
identity  20 operations with a per-operation security array, 11 declaring [], no document-level
billing    0 with per-operation security,  0 declaring [], no document-level auth
muse       0 with per-operation security,  0 declaring [], document-level auth
darkroom   0 with per-operation security,  2 declaring [], document-level auth
pantry     0 with per-operation security,  0 declaring [], no document-level auth
courier   10 with per-operation security,  0 declaring [], document-level auth
```

A client that respected the arrays would send unauthenticated requests to at least
four of six services, and the failure would be a 401 from a service rather than an
error from the client.

This paragraph used to carry the same measurement as prose — "eleven identity
operations and six courier ones" — and it went stale the moment identity-08
landed, while the sentence around it still read like a finding. That is the reason
it is a computed assertion now: a number inside a comment cannot fail, and a
measurement that cannot fail is a memory.

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
those repositories are on `master`.

`test/spec-drift.test.mjs` narrowed that second gap from "nothing" to "a printed
number and a nine-commit budget", and it is worth being precise about what remains.
It proves every vendored document is byte-for-byte what its repository said **at
the recorded commit**, which is a claim that is true or false for a reason inside
this repository. It does **not** prove the recorded commit is `master`. The
staleness report prints the distance on every run and fails past the budget; the
move itself is `npm run vendor -- --bump`, and it is still a human decision. All
six were at their published heads when cafaye-ts-01b ran, which is why the report
reads `6 current, 0 behind` — and that is a measurement of one afternoon, not a
property the package has.

It also says nothing about whether a **service** honours its own document. The
generated types come from the documents, so a service that drifts produces a
wrong value shaped like a right one, and no amount of type checking sees it.
`npm run e2e:identity` is the partial answer — a real identity against a real
Postgres, driven through this client — and it is not in the gate, because a gate
that needs a database and a running service is a gate nobody can run. What it
found on its first run is in `REPORT-cafaye-ts-01b.md`; three of the five things it
checked that turned out to be wrong were wrong in the script, not in the client.

**`identity`'s document does not describe everything `identity` serves.** Its
router has `GET /v1/accounts` and `POST /v1/accounts` — `internal/httpapi/accounts.go`
documents both and `authz_matrix_test.go` calls the GET — and `openapi/v1.yaml`
has neither. So this client cannot name the account a registration created, which
is why `scripts/e2e-identity.mjs` reads one account id out of `psql` and says so
in its header. That is drift in the direction the drift test does not cover: not
"the copy is old" but "the document is incomplete". Closing it means editing
identity's document, which this repository does not own.

**`expectOperations` is a tripwire on SIZE, not a lock on the surface, and the
difference is measured.** A document that loses one operation and gains another
moves no count. `npm run vendor` re-measures, sees `31 === 31`, updates the
index's `operations`, `paths`, `bytes` and `sha256` from the new bytes, writes it
and reports success; `npm run verify:specs` then agrees with itself; regeneration
is a clean no-op against the new tree; `test/regeneration.test.mjs` passes,
because the committed tree IS what the pinned generator produces; and a client
has silently lost a method. All of that was run, in a throwaway copy, and the
tree it produced was missing `liveness` and had a `createWidget` nobody wrote.
`REPORT-cafaye-ts-02b.md` §5 has the commands.

The alternative is a set rather than a count, and it is not in place: it needs a
per-operation record in `specs/index.json`, which is a schema change and a
migration of six entries. Until then `test/customer-capability.test.mjs` is the
partial answer — it names twenty-three operations a customer needs, so a swap
that touches one of them is red. A swap that touches none of them is not. That
sentence is the honest scope of the protection, and the README says it too.

## What a customer cannot do through this client

Added by cafaye-ts-02b, and it is the answer to a question every other check in
this repository is silent about: not "is the pipeline in order" but "can the
product be bought".

**A generated client is exactly as capable as the documents it was generated
from.** `identity` serves ten tenancy operations — `POST` and `GET /v1/accounts`,
`GET`/`PATCH`/`DELETE /v1/accounts/{account_id}`, `GET
/v1/accounts/{account_id}/members`, `POST
/v1/accounts/{account_id}/invitations`, `PATCH` and `DELETE
/v1/accounts/{account_id}/members/{user_id}`, `POST /v1/invitations/accept` — and
its `openapi/v1.yaml` describes **none** of them. Its own
`internal/httpapi/openapi_drift_test.go` holds all ten in a `knownDrift` map whose
comment says the list "cannot grow and cannot be emptied", and its `cafaye.yml`
carries a DECISION NEEDED (D1) describing them as served "and written down in no
document". So this client can `listApiKeys` and `registerOidcClient` and has no
way to make the account those belong to. `parlor` — the launch-scope product —
has all ten hand-written in `src/lib/identity.ts`, transcribed from identity's Go
handler, with a comment saying that is why.

**`test/customer-capability.test.mjs` states that as a failing test**, with the
required set in `scripts/lib/capability.mjs` carrying a reason per operation and
a first test that fails if any reason goes missing. Four verdicts, kept apart
because the two failures have different owners: `present`, `absent-from-client`
(**this repository** — the document says it and the client does not, so the
generator or the pipeline lost something), `absent-from-document` (**the
service** — regenerating cannot help), and `no-vendored-document` (**this
repository, structurally** — `specs/index.json` records one `path` per service, so
`identity`'s second document, `openid/openid.yaml`, and the nine OpenID Connect
operations in it, can never be vendored by any bump).

**Never hand-write the method.** Case 2 of `test/capability_self_test.sh` writes
`createAccount` into a copy of `sdk.gen.ts` **and** into the generated `index.ts`
— the entry file re-exports by name, so one edit is not even visible to a
consumer — and asserts the check is still red, naming the method and the verdict
beside each other. A method whose generated siblings are absent is a lie about
what the document says, and the next `npm run vendor` reverts it.

**The check is proven in both directions** by `mise run
capability-self-test`: a control that must be red with both named verdicts, a
document edited and regenerated that must be GREEN for tenancy and still red for
OIDC, the hand-written method above, and nine-of-ten documents red again naming
one operation. It is outside `prime` because `bin/prime` runs `npm test` and the
glob `test/**/*.test.mjs` cannot match a `.sh` — a self-test inside the gate would
mean the gate runs the check that fails on purpose.

**`bin/prime` is red and that is the deliverable.** `# tests 210  # pass 208  #
fail 2  # skipped 0`. `gate.yml`'s `suite-pass` floor is 208, and the paragraph
beside it says what the two failures are and that `test.skip` and a lowered floor
are both the wrong repair. `REPORT-cafaye-ts-02b.md` separates what this
repository can fix from what only `identity` can, and does not blur them.

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

The current floor is **208 pass, 0 skipped, 2 fail**. cafaye-ts-01b's baseline
was 201; cafaye-ts-02b added `test/customer-capability.test.mjs`, which is six
green tests and two that are **red on purpose** — that is the finding, not a
defect, and the section above says which two. Do not go below the current
number, and do not fix a red test by loosening an assertion, raising a retry or
adding a sleep. **And do not "fix" those two by skipping them:** `# skipped 0` is
a proof, `test.skip` fails it, and a skipped check is not a passing one.

**`gate.yml` at the root declares that gate, and `minimum: 208` in it is that
floor as a number a machine reads.** It is written against core's
`schemas/gate.schema.json` and checked by core's `harness/bin/gate-check`, so
"what gates this repository", "what the gate needs from the machine" and "what
the log must say before the word green means anything" are one checked file
rather than three things to remember. `mise run prime` is the declared command
and `bin/prime` is the entrypoint; run the static check from a core checkout with
`harness/bin/gate-check --prove .`.

**`# skipped 0` is load-bearing in a way it was not before cafaye-ts-01b.**
`test/spec-drift.test.mjs` is the first test in this repository that can skip on a
perfectly healthy machine — it skips when there is no cafaye workspace beside the
checkout, which is exactly what a self-hoster's `npm install` from npm looks
like. Eleven verified passes is the correct answer there. Eleven skipped checks
reported as eleven passes is the cafaye-rb defect again, and the `# skipped 0`
proof is what makes it impossible. A run that skips the drift test is a run that
verified nothing about provenance and says so in a number the gate reads.

**CI clones the six services before `bin/prime`, in that order, for a plumbing
reason worth knowing about.** `$GITHUB_ENV` applies to *later* steps only, so a
clone step placed after `bin/prime` would leave `npm test` running without
`CAFAYE_WORKSPACE` and skipping eleven tests while reporting green. And the clones
are deliberately **not** `--depth 1`: a shallow clone cannot resolve a recorded
commit that is not its tip, and the drift test reports that as CANNOT VERIFY, so
cloning shallow to save 30MB would make the check quietly vacuous in CI — the
exact failure mode the test was written to prevent.

**Raise `minimum` in the same commit that adds a test.** It is a ratchet, not a
target: a suite that quietly lost tests cannot report itself as passing, and a
floor left behind stops protecting anything. Adding a test does not fail the gate
on its own — that is the deliberate cost of not putting the assertion in the
suite — so the rule is a human one, and the declaration says so where the next
reader will find it.

**`mise run gate-self-test` breaks `gate.yml` thirteen ways and asserts core's
checker catches each.** It is deliberately not part of `prime`: `bin/prime` runs
`npm test`, so a self-test inside the gate would mean the gate runs the checker
and the checker runs the gate. It needs a cafaye/core checkout (`CAFAYE_CORE`, or
it finds `../core`) and exits **2** rather than skipping if there is not one.

**Two things about it are fixed rather than working by accident, and both were
found while writing the sibling `capability_self_test.sh` rather than by anything
looking for them.** Its copies run the whole suite, and `spec-drift.test.mjs`
resolves the six checkouts relative to the repository it runs in — so a copy under
`$TMPDIR` skipped eleven times, which failed `suite-no-skip` *and* dropped `# pass`
by eleven, which failed the floor. Both fired on the control, and the self-test
reported a red that had nothing to do with `gate.yml`. It now hands every copy a
`CAFAYE_WORKSPACE`, resolved by importing this repository's own
`scripts/lib/workspace.mjs` rather than by re-deriving the search order. And its
case 11 was `edit 'minimum: 187' 'minimum: 188'`, correct when 187 was the floor
and silently stale since cafaye-ts-01b raised it to 201 — it now reads the live
number, with `grep -Eo` rather than a `sed` `\+`, because BSD sed reads that as a
literal plus and the case therefore only worked on Linux.

**Its control no longer requires the gate to exit 0, and that is the consequence
of this packet rather than a loosening.** The suite is red on purpose, so the
exit code carries no signal. What the control requires instead is stronger where
it counts: both count-bearing proofs satisfied, and `gate.nonzero` the *only*
finding that fired. Case 13's `gate.nonzero` clause is gone, with the removal
explained at the case rather than made quietly.

**`mise run capability-self-test` proves the capability check is load-bearing**,
four cases, and its header lists them. Outside `prime` for the same structural
reason, and it needs `node_modules` but no cafaye checkout, no database and no
network.

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
  provenance and never edits them. All six were re-vendored at their current
  masters by cafaye-ts-01b; the next bump is somebody else's decision.
- **A document's completeness.** The drift test proves the vendored copy is what
  its source said at the recorded ref. It cannot prove the document describes
  everything the service serves, and identity's does not: `GET /v1/accounts` and
  `POST /v1/accounts` are in its router and absent from `openapi/v1.yaml`. Fixing
  that is an edit to identity's document.
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
  `scripts/e2e-identity.mjs` is where you can watch it directly, because it
  introspects a real token and prints both.

## `npm run e2e:identity`, and why it is not in the gate

`scripts/e2e-identity.mjs` drives a real `identity` — built from source, running
against a migrated Postgres — through this client, and it asserts 41 things about
what comes back. It registers a user, signs in, reads the session back, mints a
scoped API token, introspects it, revokes it, and checks identity's own RFC 9457
error bodies become typed exceptions.

It is **not** in `npm test`, and it must not be put there. `bin/prime` runs the
suite; a suite that needs a database and a running service is a suite nobody can
run, and `test/suite-is-offline.test.mjs` exists to keep sockets out of CI. The
separation is not a compromise — the two checks answer different questions. The
suite proves the artifact is what the provenance says. The e2e proves the artifact
talks to a real service, which is the one thing the suite structurally cannot.

Set it up with a migrated database and `npm run e2e:identity`; the recipe is in
`REPORT-cafaye-ts-01b.md`. **Do not edit `identity` to make it pass.** Its
document and its code were right every time the script was wrong, and the three
times they were wrong is the most useful thing the run reported — which is only
worth having because nothing was bent to accommodate the expectation.
