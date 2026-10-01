# REPORT — cafaye-ts-01b

**The client was describing services that had moved underneath it. This packet
re-vendors all six, makes the drift a gate, and drives the result against a real
service.**

Branch `worker/cafaye-ts-01`. Nothing pushed, nothing merged, nothing tagged. No
runtime dependency added — `dependencies` is still `{}` and `test/no-runtime-dependencies.test.mjs`
still walks the module graph and fails on any specifier that is not relative or a
builtin.

| | |
|---|---|
| Gate | `bin/prime` → **201 pass, 0 fail, 0 skipped** (was 187) |
| Floor | `gate.yml` `minimum: 187` → **`201`**, same commit as the tests |
| Documents | six of six re-vendored at their current masters, five changed bytes |
| Operations | fleet total **53 → 70** |
| Drift | `test/spec-drift.test.mjs`, 11 assertions, all six services |
| End-to-end | `npm run e2e:identity`, 41 assertions, real identity + real Postgres |
| Decisions made | 3, all recorded below with the reasoning |

---

## What was already established, and what this packet did with it

The analysis from the first pass stands and was not redone: identity 16 → 31
operations and 12 → 26 paths, courier 8 → 10 with `/v1/messages` `sendMessage`,
smaller deltas elsewhere. What follows is what was built on it.

---

## 1. All six documents, not the two in launch scope

The instruction was to regenerate all six, and `muse` is the reason it is right
rather than merely thorough.

`muse`'s auth moved from *"the presence of a bearer credential is checked, and
the token is not verified"* to a **verified JWT** that must additionally carry
`completions:write` and an `account_id`, with a **403 that did not exist before**.
A client that describes an unenforced auth model is not out of date, it is wrong:
a caller generated from it writes code that gets 401s. That is a correctness
problem in the artifact and it does not wait for a launch decision.

| Service | Operations | Paths | Document version | |
|---|---:|---:|---|---|
| `identity` | 16 → **31** | 12 → **26** | 1.2.0 → **1.5.0** | fifteen new operations |
| `courier` | 8 → **10** | 4 → **6** | 1.2.0 → **2.2.0** | `sendMessage`, `receiveResendReport` |
| `billing` | 15 | 11 | 1.1.0 → **1.3.0** | |
| `muse` | 1 | 1 | 1.0.0 → **1.1.0** | auth model moved, MIT not AGPL |
| `pantry` | 4 | 4 | 1.1.0 | |
| `darkroom` | 9 | 7 | 1.0.0 | **sha256 unchanged — verified no drift** |

**`darkroom` is a result, recorded rather than passed over.** Its document is
byte-identical at the new commit, so the recorded sha moved and the vendored file
was not rewritten — `npm run vendor` printed `[index]` with no `document` flag,
and the digest is the same `46c6515ba916…` it was before. The only honest reading
available for a service whose document did not change is that it did not change,
and the drift test now produces that same evidence on every run.

### What identity's fifteen additions are

Four groups, and the third is the one that matters for §4:

- **Scoped API token surface** — `listApiKeys`, `mintApiKey`, `revokeApiKey`,
  `introspectApiKey`.
- **Account admin surface** — `listAccountAuditLog`, `revokeAccountInvitation`,
  `revokeAccountInvitations`.
- **Self-service mail surface** — `requestPasswordReset`, `confirmPasswordReset`,
  `requestEmailVerification`, `confirmEmailVerification`,
  `getEmailVerificationStatus`, `requestEmailChange`,
  `confirmEmailChangeCurrentAddress`, `confirmEmailChangeNewAddress`.
- Plus four OIDC client operations and four that were already in the previous
  document under a different count.

### Breaking, for anyone who counted

`cafaye.identity` has 31 operations rather than 16 and `cafaye.courier` has 10
rather than 8. **No operation was removed or renamed, so no call site breaks.** The
README's table moves from 53 to 70 and is asserted against `specs/index.json`.

`expectOperations` moved with the documents it counts, in the same commit, which
is what `AGENTS.md` requires. `test/vendored-specs.test.mjs` holds the same
numbers **independently**, and that is not duplication for its own sake: the
vendor enforces the index's copy and the test enforces the hand-measured one, so
relaxing a count quietly fails one of them.

---

## 2. The drift test — the deliverable

`test/spec-drift.test.mjs`. It asserts, for all six services:

> `specs/<name>.yaml` is byte-for-byte the contents of `<repository>:<path>` at
> `<commit>`, read out of a local checkout with `git cat-file`.

### The gap it closes, named

The existing sha256 check proved the vendored bytes matched `specs/index.json`.
Both of those were stale **together**, so the suite was green over a client
describing a service that had not had a scoped API key route for months. A
consistency check between a file and the record of that file cannot detect that
both moved.

### Recorded commit, never the working tree

Borrowed from `pantry/tests/recorded_copy.rs`, and borrowed because pantry already
paid for the other version. Its `tests/drift.rs` compared against the working
tree, so `identity-09` and `muse-06` landing turned **pantry's** gate red in a
repository nobody had touched, and each red was reported as pantry being broken —
which is how a comment-only staleness and a registry publishing `required: false`
for a dependency muse had made **required** both arrived as the same story.

Here the same shape would be worse, because the vendored document is not a copy
for display, it is **the artifact the generator reads**. A test comparing to the
working tree would go red every time any service merged, and every red would be
reported against `cafaye-ts`. The difference is *who a red belongs to*: at a
recorded ref, "a merge in `identity`" and "somebody edited `specs/identity.yaml`"
become different failures, and only the second is a defect in this repository.

### Three failure shapes, three answers, and none of them is a pass

| Situation | Answer |
|---|---|
| no workspace at all | **SKIP**, loudly, naming every directory searched |
| workspace present, recorded ref unresolvable | **FAIL** — "cannot verify" |
| workspace present, bytes differ | **FAIL** — naming the ref, both digests, the first differing line |

The skip uses `t.skip()`, so `node --test` counts it in `# skipped` and **not** in
`# pass`, and `gate.yml`'s existing `# skipped 0` proof goes red. That proof was
added before this test existed and now earns its place: this is the first test in
the repository that can skip on a perfectly healthy machine, and a self-hoster's
`npm install` from npm is exactly that machine. Eleven verified passes is the
right answer there; eleven skipped checks reported as eleven passes is the
cafaye-rb defect again.

The shallow-clone case is **measured, not described**. A real
`git clone --depth 1` of `identity`, with `specs/index.json` naming the old
`35c2576`, produces:

```
1 of 6 recorded commits could not be read from a local checkout, so this run
CANNOT verify the vendored documents:

  identity: <path> is a SHALLOW clone (depth-limited history), which cannot
  resolve 35c2576ede65. Un-shallow it — `git -C <path> fetch --unshallow` — or
  re-vendor with `npm run vendor -- --bump`. This is "cannot verify", NOT
  "verified".

# pass 8   # fail 3
```

Three failures, not eleven passes. Two further proofs, both run for real: a
hand-edited `specs/courier.yaml` fails naming the edit, and a bumped-but-not-
recopied `identity` fails naming both digests and the first differing line.

### Staleness is a report with a budget, not a gate

The distance from each recorded commit to its service's published head prints on
every run, and a copy more than **9 commits** behind fails with the command that
closes it. Not zero — zero is exactly the defect this replaces. Not unbounded —
unbounded is the "quiet and still wrong" it replaces, where the document is
accurate as of its recorded ref and nobody has been told `identity` has merged
fifteen times since. Nine is roughly a working day of this fleet's merge rate,
and it is a named `const` so moving it is a visible diff.

All six read `current` when this was written. That is a measurement of one
afternoon, not a property the package has.

### One implementation of "where is the fleet"

`scripts/lib/workspace.mjs` is new and `scripts/vendor.mjs` imports it. The
vendor and the test both need to resolve the workspace and read a document out of
it, and two implementations is two answers — the drift test's entire claim is
that it compared the bytes the vendor wrote, and a second copy of the resolution
would make that claim false in precisely the way this repository's own header
warns about. Refactoring the vendor to share it is what made that claim checkable
rather than merely stated.

While there: the vendor's origin check compared **URL strings**, which meant a CI
job's legitimate HTTPS clone of the right repository was refused. It now compares
`owner/name`. The check that matters is "is this the right repository" — which
catches a fork — and not "is this the right transport".

### CI clones the fleet, before the gate

Without this the drift test skips on every CI run and the check this packet is
about never runs anywhere automated. Before `bin/prime`, because `$GITHUB_ENV`
applies to later steps only — a clone afterwards would leave `npm test` skipping
eleven tests while reporting green, which is the exact failure arriving through
the plumbing. Not `--depth 1`, for the reason the shallow case is a failure.

---

## 3. The real end-to-end call

`npm run e2e:identity` (`scripts/e2e-identity.mjs`). A real `identity`, built
from source, running against a migrated Postgres, driven through this client.
41 assertions, no mock, no fixture, no interception, and **no edit to identity**.

### The setup, so it is repeatable

```sh
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"

psql postgresql://127.0.0.1:5432/postgres \
  -c "CREATE ROLE cafaye_ts LOGIN PASSWORD 'cafaye_ts'" \
  -c "CREATE DATABASE cafaye_ts_e2e OWNER cafaye_ts"

cd ../identity
goose -dir migrations postgres \
  "postgresql://cafaye_ts:cafaye_ts@127.0.0.1:5432/cafaye_ts_e2e?sslmode=disable" up

go build -o /tmp/identity-e2e ./cmd/identity
DATABASE_URL="postgresql://cafaye_ts:cafaye_ts@127.0.0.1:5432/cafaye_ts_e2e?sslmode=disable" \
  PORT=18081 LOG_LEVEL=debug /tmp/identity-e2e &

cd - && npm run build && npm run e2e:identity
```

`/readyz` answers `{"status":"ok","deps":"postgres"}`.

**`goose`, not `bin/migrate`.** identity's `bin/migrate` applies every file with
a bare `psql -f`, and `-- +goose Up` / `-- +goose Down` are *comments* — so it runs
the Down section too. Observed directly: `00002_users.sql` printed `CREATE TABLE`,
`CREATE INDEX`, `DROP TABLE`, and the schema was left empty. The file's own header
claims the opposite ("a plain `psql -f` runs exactly the Up section and ignores
the Down one"). `migrations/README.md` already names `goose` as the tool for a
developer applying migrations by hand, and it is correct. **This is a defect in
`identity/bin/migrate` and it is not fixed here** — see §5.

### What it proves

```
1. the namespace the freshly vendored document produced
   31 bound operations
2. register and sign in, through the generated transport
   ok  registerUser returned a user identity really inserted
   ok  createSession returned a session token (PoA52oT4RrKo…)
3. the credential discriminator, against both shapes identity mints
   ok  classified as a session, so it may also travel as the cookie identity accepts
   ok  getCurrentUser resolved that session to a real row
4. mintApiKey / introspectApiKey / revokeApiKey — none existed in the old document
   ok  it carries identity's own `cafaye_` prefix, the discriminator credentials.ts reads
   ok  and 43 characters after the prefix, which is identity's documented shape
   ok  the client classifies it as an apiToken, not a session
   ok  introspectApiKey resolves it (active=true)
   ok  and MD7's ambiguity is visible here: identity emits both claim names
       scope="accounts:read" scopes="accounts:read"
   ok  a scoped token is REFUSED on the session route with the 401 identity documents
   ok  and REFUSED with 403 on the api-key routes — deliberate: a token cannot
       manage tokens
   ok  after revokeApiKey the credential no longer resolves (active=false)
   ok  the revoked row is kept and still listed, carrying revoked_at
5. identity's own problem document, through this client's exception hierarchy
   ok  a typed CafayeUnauthenticatedError, not a bare Problem object
   ok  carrying identity's own `code`, a status, and a trace_id
   ok  and no credential anywhere in the message or the stringified error
6. no credential at all
   ok  an unauthenticated call is a typed Cafaye error, not a crash

e2e: every step passed
```

### The most useful thing it reported was about the script

**Five assumptions in the first version were wrong, and the client was right every
time.** That is only worth having because nothing was bent to accommodate the
expectation, which the brief forbade and which is why it is worth saying plainly.

| What the script assumed | What identity said |
|---|---|
| `introspectApiKey` takes `{key}` | 422 — the generated `IntrospectRequest` types the field `token`. The compiler would have caught it; the script is `.mjs` |
| a scoped token resolves `/v1/me` | 401, documented: *"A scoped token is accepted on the account-scoped routes only"* |
| a scoped token manages API keys | 403, and `authz_matrix_test.go` says so in words: *"There is NO scope for this surface, which is what keeps a token off these three routes"* |
| `listApiKeys` returns `{keys}` and the row id is `key_id` | an array, and the id is `jti` |
| a revoked key leaves the list | it stays, carrying `revoked_at` — *"a deleted row answers [the support question] for nobody"* |

Each one is in the script as a comment now, because a person rewriting it will
make the same five assumptions. The type layer was correct in all five cases; the
only defect found in this repository was that the harness was written in plain
JavaScript so nothing checked it, which is why `scripts/e2e-identity.mjs`'s header
says so.

### One thing it reads out of band, and why

The account id for the API-key steps comes from `psql`. identity's router serves
`GET /v1/accounts` and `POST /v1/accounts` — `internal/httpapi/accounts.go`
documents both, `authz_matrix_test.go` calls the GET — and `openapi/v1.yaml`
describes **neither**. There is no HTTP path on this client's surface that can
name the account a registration creates. That is a real finding about identity's
document, recorded in §5, and it is why the step says it reads out of band rather
than quietly skipping.

### It is not in the gate, and must not be

`bin/prime` runs `npm test`. A suite that needs a database and a running service
is a suite nobody can run, and `test/suite-is-offline.test.mjs` exists to keep
sockets out of CI. The separation is not a compromise — the two checks answer
different questions. The suite proves the artifact is what the provenance says.
The e2e proves the artifact talks to a real service, which is the one thing the
suite structurally cannot. No dependency was added to get it working: `psql` is a
subprocess, because `dependencies` is `{}` and stays `{}`.

---

## 4. `parlor` — do not touch it, but the finding is sharper now

Another session is in `parlor` right now. Nothing there was changed. The
recommendation is written up so it can be actioned deliberately later.

### What was found, against the current state

`parlor/src/lib/identity.ts` is **549 lines** with its own `send()` helper and a
transported type. It speaks:

`/v1/users`, `/v1/session`, `/v1/me`, `/v1/accounts` (+ members, invitations),
`/v1/invitations/accept`, `/v1/password-resets`, `/v1/password-resets/confirm`.

Checked each against `identity`'s **current** document:

| Route parlor calls | in `openapi/v1.yaml` at `793977b`? |
|---|---|
| `/v1/users`, `/v1/session`, `/v1/me` | yes |
| `/v1/password-resets`, `/v1/password-resets/confirm` | **yes — new in 1.5.0** |
| `/v1/accounts`, `/v1/invitations/accept` | **no** |

The password-reset routes parlor hand-rolls became describable in the document
this packet vendored. And `courier`'s new `POST /v1/messages` is documented as
*"the operation the platform's password reset, email verification, email change
and team invitation flows call; until it existed those endpoints were
reachable-looking and none of them could complete."*

So the set parlor hand-rolls is **exactly** the set courier and identity now have
first-class operations for. That is the sharpening: it is not that a shared
client would be tidier, it is that parlor is the last place in the fleet still
calling a surface the platform has since documented, and calling `/v1/accounts`
— a route identity serves and its document omits — by hand.

parlor's own header already knows the half of this that matters:

> These shapes are transcribed from the service's own handler … They are **NOT**
> transcribed from `identity/openapi/v1.yaml`, because that document does not
> describe any of them.

That is correct as of that file's writing and **still true today** for
`/v1/accounts` and `/v1/invitations/accept`. It is no longer true for the
password-reset pair.

### What parlor should do, and what it costs

**Adopt `cafaye-ts` for the routes that are in the document, and keep a
hand-written transport only for the two that are not.** In dependency order:

1. **First, identity's document needs `/v1/accounts` and `/v1/invitations/accept`.**
   Nothing else can be clean until it does — parlor cannot generate a client for
   a route the document omits, which is the same gap §3 hit. This is an edit to
   identity, not to parlor, and it is not this repository's to make.
2. **Then parlor swaps its transport for `cafaye-ts` and deletes roughly 290
   non-blank lines** — measured, not estimated: `send()` and `parseError()` and
   the `IdentityError` block are 109 lines (334–455), and the hand-transcribed
   tenancy shapes above them are 182 (52–250). It also drops seven exported
   types (`Account`, `AccountDetail`, `AccountListItem`, `Membership`,
   `MemberList`, `Invitation`, `FieldError`) that the document now describes. The
   generated types come from identity's document, so a status code or a field name
   that moves moves here too.
3. **Then `courier.sendMessage` replaces whatever parlor does for the mail**,
   with the document's own four flow kinds (`welcome`, `password_reset`,
   `team_invitation`, …) already typed.

Costs worth stating rather than assuming:

- **parlor gains a dependency.** Zero-dependency was the selling point *here*; for
  parlor, consuming a client is the point. Its `transport` parameter goes away,
  which is a real loss for its test suite — the current design is that a test can
  never reach the network. That is the largest single cost and it is not
  avoidable.
- **`Cafaye` resolves all six base URLs in its constructor**, so parlor must
  configure six to use one. A consumer that only wants identity pays for the
  fleet's shape. Worth deciding whether a per-service entry point is wanted
  before parlor adopts it; `cafaye-ts/services/identity` already exists.
- **The RFC 9457 error mapping changes shape** for parlor: a bare
  `IdentityError` becomes a thrown typed exception. Every call site moves from
  `try { … } catch` to the same shape, which is the bulk of the diff.
- **Timing.** Steps 1 and 2 are separable, and step 2 is worth doing even if step
  1 never happens — the four documented routes are enough to delete a real chunk.

**Recommendation: do step 1 in `identity` first, and do not start step 2 until it
lands.** Adopting a client for four of six routes leaves the two hand-written ones
hand-written anyway, and the awkward middle state is where a reader cannot tell
which types are generated.

---

## 5. Findings in other repositories, reported not fixed

Everything outside `cafaye-ts` was read-only. Four things are worth someone's
attention, ranked by how much they cost.

### `identity/bin/migrate` applies every migration's `Down` section

**Severity: high. It makes a developer's first `bin/dev` produce a service with
no schema.**

The file's header states the reasoning: *"`-- +goose Up` and `-- +goose Down` are
comments, so a plain `psql -f` runs exactly the Up section and ignores the Down
one."* That is the opposite of what `psql` does. Observed:

```
$ psql "$DATABASE_URL" --variable ON_ERROR_STOP=1 --file migrations/00002_users.sql
CREATE TABLE
CREATE INDEX
DROP TABLE
```

Every migration is idempotent in the sense the header claims (`CREATE TABLE IF
NOT EXISTS`, guarded `DO` blocks) — which is exactly why this went unnoticed. Each
file creates its objects and then drops them, and the schema is left empty with no
error. `00003_sessions.sql` then fails on `relation "users" does not exist` if a
file is not perfectly re-runnable, which is the only symptom.

`kit`'s `bin/dev` calls `bin/migrate` (it probes for it first), so this is the
default local path. `migrations/README.md` already says `goose` is the tool for a
developer applying migrations by hand — the fix is to make `bin/migrate` do that,
or to stop pretending `psql -f` is a goose.

### `identity`'s document omits routes its router serves

**Severity: medium. It makes a generated client unable to reach real capability.**

`GET /v1/accounts`, `POST /v1/accounts` and `POST /v1/invitations/accept` are in
`internal/httpapi/accounts.go` and absent from `openapi/v1.yaml`. Measured
directly in §3: the e2e had to read an account id out of `psql` because no
generated operation can name it.

parlor already compensates for this by transcribing from the handler, and says so
in its own header. Every future generated client for `identity` will hit the same
wall. Closing it is a document edit in `identity`, after which this repository
re-vendors and regenerates with no other change.

### `identity` answers a 403 whose scope name is empty

**Severity: low. Cosmetic, but it is in a body clients display.**

`accountRouteScopes` has no row for the three API-key routes — deliberately, so a
token cannot manage tokens — and `scopeRequiredBy` returns `""` for them. The 403
message interpolates it:

```
"this api key does not carry the " + scopeRequiredBy(r) + " scope"
```

which renders as `this api key does not carry the  scope`, with two spaces and no
name. An empty required scope is not a scope; the message should name the surface
instead. Reproduced live in §3's step 4.

### `identity` has no client-facing way to create an account for a user

Not a defect — a gap. Accounts come from the platform's provisioning, and the
document offers no operation for it. It is listed because §3 had to reach into
the database to get an account id, and the next person hitting the same wall
should not have to rediscover why.

---

## 6. Decisions made without asking

Three, per the instruction to make the call and write the reasoning.

**a. All six documents, including the out-of-launch ones.** Not a close call:
`muse`'s auth model is a correctness property of the artifact, and a launch
decision does not change whether the service enforces it. `billing` and `pantry`
came along because a vendor that skips services is a vendor whose output depends
on a launch list nobody reading the client can see.

**b. Staleness budget of nine commits, as a report and not a gate.** Zero is the
defect pantry shipped; unbounded is the silence this replaces. Nine is pantry's
number and this fleet's merge rate justifies it, and it is a named constant so
changing it is a visible diff rather than an edit to a number inside a sentence.

**c. `scripts/e2e-identity.mjs` is committed but is not in the gate.** The brief
asked for a real end-to-end call; committing it means the next person does not
rebuild it, and keeping it out of `npm test` keeps a self-hoster's and a CI
runner's suite runnable. Both, deliberately — and `gate.yml`'s `external` block
now says so in the place a reader checks.

Two smaller calls, for the record: the **vendor's origin check was relaxed to
`owner/name`** rather than keeping exact-URL matching, because exact matching
refuses a CI runner's legitimate HTTPS clone of the right repository; and
**`test/suite-is-offline.test.mjs`'s git rule was widened** (`[^'"\n]` → `[^\n]`)
rather than the drift test's prose reworded, because the rule had a real hole and
the prose was correct.

---

## 7. What a green run proves, and what it does not

`bin/prime` exits 0 with `# pass 201`, `# fail 0`, `# skipped 0`, and
`npm run typecheck` compiles all 96 generated files and the whole of
`src/cafaye/`. `npm run generate` is a no-op afterwards, which proves the
committed tree is exactly what the pinned generator produces from the committed
documents.

It proves:

- every vendored document is byte-for-byte what its service said **at the recorded
  commit**, for all six;
- every recorded commit is at its service's published head within nine commits;
- regeneration is deterministic and committed;
- the wrapper's four responsibilities behave as documented.

It does **not** prove:

- that a service honours its own document. The types come from the documents, so a
  service that drifts produces a wrong value shaped like a right one. §3 is the
  partial answer and it is not in the gate.
- that a document is **complete**. The drift test compares a copy to a ref; it
  cannot notice a route the source never described. §5, second finding, is exactly
  that, and it is invisible to every check here.
- that the recorded commits are still `master` in six months. The report prints
  the distance; the move is `npm run vendor -- --bump` and it is still a person's
  decision.
- anything about `parlor`, which was not touched.

---

## 8. Commits on this branch

| | |
|---|---|
| `77ad30d` | vendor: all six documents re-copied at their current masters, and regenerated |
| `f4e11a9` | test: the vendored documents are what each service said at the recorded commit |

Two, because the regeneration had to land before the tests that read a clean
committed tree — `regeneration.test.mjs` and `hand-edit-is-reverted.test.mjs` both
use `git diff`, and a dirty tree fails them for a reason that has nothing to do
with the generator. The report is this file.

**Verified before writing any of it:** `bin/prime` exits 0; `npm run vendor
--verify-only` resolves all six at their recorded shas with `[no change]`;
`npm run e2e:identity` prints `e2e: every step passed`; the shallow-clone,
hand-edit and stale-ref proofs each produce the failure quoted above.