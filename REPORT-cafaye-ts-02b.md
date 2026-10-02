# REPORT-cafaye-ts-02b — the client cannot onboard a tenant, and now it says so

**Packet:** cafaye-ts-02b
**Branch:** `worker/cafaye-ts-02`
**Base:** `287ec76` (`Merge cafaye-ts-01b`)
**Date:** 2026-10-02
**Gate state:** **RED.** `# tests 210  # pass 208  # fail 2  # skipped 0`.
`./bin/prime` exits 1. The two failures are the finding.

---

## 1. The short version

A customer who installs this package to buy "hosted identity + courier" can
register a user, sign them in, mint an API key, register an OIDC client and send
a transactional message. They **cannot create an account, invite anybody, accept
an invitation, or list and change members** — and they **cannot integrate this
platform's OpenID Connect provider into their own product at all.**

Fifteen operations, in two groups with two different owners:

| # | Missing | Verdict | Whose it is |
|---:|---|---|---|
| 10 | `identity` tenancy: `POST`/`GET /v1/accounts`, `GET`/`PATCH`/`DELETE /v1/accounts/{account_id}`, `GET …/members`, `POST …/invitations`, `PATCH`/`DELETE …/members/{user_id}`, `POST /v1/invitations/accept` | `absent-from-document` | **`identity`.** All ten are **served**; `openapi/v1.yaml` describes none of them. |
| 5 | `identity`'s OIDC provider surface: `GET /.well-known/openid-configuration`, `GET /.well-known/jwks.json`, `POST /oidc/token`, `GET /oidc/userinfo`, `GET /oidc/authorize` | `no-vendored-document` | **This package.** All five are documented — in `openid/openid.yaml`, a second document in identity's repository that `specs/index.json` has no way to record. |

Neither is fixable by regenerating. Neither belongs in `src/services/` as a
hand-written method, and §4 is the measurement that proves the second half of
that.

The brief asked me to derive the required set from the artifacts rather than from
its list, and to say if the gap is wider than tenancy. **It is wider, and the
wider half is ours.** See §6.

---

## 2. What I added

| File | What it is |
|---|---|
| `scripts/lib/capability.mjs` | The required set as data — 23 operations, 6 steps, a `why` per operation — plus the two measurements and the four verdicts. |
| `scripts/capability.mjs` | `npm run capability`. The same finding as a list, for a person. Exits nonzero. |
| `test/customer-capability.test.mjs` | **The gate-visible check. Two of its eight tests are red on purpose.** |
| `test/capability_self_test.sh` | `mise run capability-self-test`. Four cases proving the check can go green, and that a hand-written method cannot make it. |

Four decisions in the shape of that, each of which I would defend:

**The required set is data with a reason per entry, and a test fails if a reason
goes missing.** A requirement with no stated reason is an assertion rather than a
reviewable claim — the same distinction identity's own `knownDrift` draws between
an exclusion and an admission, and it is why its drift test rejects a blank
reason. Deriving the set from a list in a report is how the report's list and the
code's list part company.

**The generated client is PROBED, not parsed.** `probeNamespace` calls every
exported function of every generated namespace with a recording client and reads
back the `(method, url)` each one issues. It measures the built artifact — what
a consumer installs — with no source parsing and no regular expression over a
generator's formatting. `url` is the generator's own template with
`{account_id}` unexpanded, because expanding it would be a guess about a
parameter value and a comparison that had to guess could be wrong invisibly.

**The four verdicts are kept apart, and the two failures are not merged.** A
document that does not describe an operation is the service's to fix. A document
that describes one the client lacks is ours, and it would be a generator or
pipeline failure worth chasing immediately. A red that names the wrong repository
is worse than no red, and merging the two would produce fifteen lines all pointing
the same way.

**The wrapper is not probed, and that is not an omission.**
`test/wrapper-class.test.mjs:216` already asserts `cafaye.<service>` exposes
exactly the function exports of the generated namespace, so the namespace is the
same set of operations one layer up.

### The eight tests, and which are red

```
describe('the customer path, as a stated requirement')
  ok  1  names every required operation, with a service, a method, a path and a reason
  ok  2  the probe finds an operation that is there                      <- the CONTROL
  ok  3  the probe is not a match-all: it rejects a wrong method and a wrong path
  ok  4  every operation the six documents declare is reachable through the generated client
  ok  5  every generated method reaches a path its own document declares
  ok  6  a customer can send a transactional message                       <- courier is fine
describe('the customer path a customer cannot yet walk')
  RED 1  a customer can create an account, invite a member, accept the invitation, and obtain a session
  RED 2  a customer can put this platform's sign-in on their own product
```

Tests 4 and 5 are what make the `absent-from-client` verdict mean something. If a
document declared an operation the client could not reach, they would go red — and
on this tree they never fire, which is why a red of that kind would mean the
generator broke rather than that the documents are thin.

Test 2 is the control that makes the reds legible. A file that has only ever been
red might be red because it is a match-all. Test 3 is the other direction.

---

## 3. The required set, derived

The rule, stated once in `scripts/lib/capability.mjs`: **an operation is required
if a customer cannot finish buying and using the product without it.** Not "it
would be convenient", not "the service has it", not "it exists upstream
somewhere". The whole finding is the distance between the second and the third,
and a list built out of the third would be a copy of the documents rather than a
statement about the product.

| Step | Operations | Present |
|---|---|---:|
| 1. A person signs up, and gets a credential | `POST /v1/users`, `POST /v1/session` | 2 of 2 |
| 2. That person gets a tenant to work in | `POST`/`GET /v1/accounts`, `GET`/`PATCH`/`DELETE /v1/accounts/{account_id}` | 0 of 5 |
| 3. Somebody else joins it | `POST …/invitations`, `POST /v1/invitations/accept`, `GET …/members`, `PATCH`/`DELETE …/members/{user_id}` | 0 of 5 |
| 4. The tenant gets a machine credential | `POST …/api-keys`, `POST …/oidc-clients`, `POST /v1/introspections` | 3 of 3 |
| 5. The customer's own product signs its users in with this platform | `GET /.well-known/openid-configuration`, `GET /.well-known/jwks.json`, `POST /oidc/token`, `GET /oidc/userinfo`, `GET /oidc/authorize` | 0 of 5 |
| 6. The product sends its transactional mail | `POST /v1/messages`, `POST /v1/webhook_endpoints`, `POST …/{id}/test` | 3 of 3 |

Two entries in step 4 are on the list precisely because they are **present**.
`mintApiKey` and `registerOidcClient` both take an `account_id` in the path, so
they exist and are unreachable — a check that only ever names what is broken is a
complaint, not a measurement, and a reader cannot tell which it is reading.

**What I deliberately left out, and why.** `GET /healthz` and `GET /readyz` run
before auth and routing exist and no customer codes against them. The three
`/admin/` operations are all in this client and all require an account id, so they
are currently unreachable for the same reason step 2 is — naming that dependency
is step 2's `why`, and listing them would double-count one gap. Four of identity's
nine OIDC operations: `GET /.well-known/oauth-authorization-server` is RFC 8414
metadata a client already gets from the OpenID document, `GET
/oidc/authorize/callback` is a redirect target the provider owns, and the
`GET`/`POST /oidc/login/{request_id}` pair is identity's own browser UI. That is
an exclusion list rather than a complete document, and it is written down so it
can be argued with.

---

## 4. Proof: the check goes green, and a hand-written method does not

`mise run capability-self-test`. I read `test/gate_self_test.sh` first and copied
its shape — copy per case, break one thing, assert the **named** finding — because
"something went red" could be any assertion at all.

```
capability_self_test — is test/customer-capability.test.mjs measuring anything?

  ok    0a  an unmodified copy runs the check and it fails
  ok    0b  ... and the tenancy failure names the ten as absent from the DOCUMENT
  ok    0c  ... and the OIDC failure names the five as having NO vendored document
  ok    0d  ... and the other six tests in the file pass
  injected 10 operations into identity's document
  ok    1a  a document that describes the ten, and a client regenerated from it, satisfies the tenancy check
  ok    1b  ... and the tenancy names are gone from the output
  ok    1c  ... while the OIDC check is STILL red, because no document was added for it
  hand-wrote createAccount into sdk.gen.ts and index.ts
  ok    2a  a HAND-WRITTEN method does NOT satisfy the tenancy check
  ok    2b  ... and it says so: the method IS in the client, and the verdict is still absent-from-document
  removed acceptInvitation
  ok    3a  nine of the ten documented and one missing is RED again
  ok    3b  ... and it names that ONE operation, and no other

11 passed, 0 failed
```

**Case 1 is the one that matters.** A copy of `specs/identity.yaml` with the ten
tenancy paths added — with operationIds, which is what a generator names a method
after — plus `expectOperations` bumped, plus `npm run generate -- identity`. The
tenancy check goes **green**. The only thing that moved between green and red is
a document. That is the whole claim of this report demonstrated rather than
argued: the fix is a document edit upstream.

**Case 2 is the boundary.** `createAccount` written by hand into a copy of
`sdk.gen.ts` **and** into the generated `index.ts`, then rebuilt. Two files,
because the generator's `entryFile: true` emits an `index.ts` that re-exports the
SDK *by name* — one long `export { … } from './sdk.gen.js'` — so a function
written into `sdk.gen.ts` alone is not reachable through
`cafaye-ts/services/identity` at all. That is a finding rather than a detail:
somebody attempting this fix has to edit two generated files, both carrying a
`DO NOT EDIT` header, and `test/regeneration.test.mjs` reverts both.

The check is still red, and says:

```
absent-from-document   POST /v1/accounts
                       it IS in the generated client, as `createAccount`
```

A method whose generated siblings are absent is a lie about what the document
says, and the next `npm run vendor` reverts it. The check cannot be satisfied by
the forbidden fix, and that is asserted rather than asserted-about.

**Case 3 is granularity.** Nine of ten documented and one missing — `POST
/v1/invitations/accept`, the one not under `/v1/accounts` and so the easiest to
overlook — is red again, naming that one operation alone. A check that could only
say "the tenancy surface is missing" could not tell this from the control.

**Two things I got wrong building this, both recorded in the script.** The
fixture started as `read -r -d '' VAR <<'YAML'`; `read` strips leading IFS
whitespace from the value it assigns, so the first line of the block lost its two
spaces, `/v1/accounts:` landed at column 0, and the generator refused the
document with a parse error 24 lines further on. It reads as a malformed recipe
and is a stripped indent. And case 1 originally asserted the whole file exits 0,
which is wrong by design: the file carries two independent findings and this case
closes one.

---

## 5. The three questions the brief asked about the pipeline

### 5.1 Does re-vendoring warn when a spec loses operations?

**Not always, and the gap is exactly a swap.** I measured it, in a throwaway copy
of this repository, editing `specs/identity.yaml` to remove `GET /healthz` and
add a `POST /v1/widgets` nobody wrote — one out, one in, count unmoved — and then
doing precisely what `scripts/vendor.mjs` does on its write path:

```
re-measured: operations 31 (recorded 31) | paths 26 (recorded 26)
expectOperations check at vendor.mjs:171 -> PASSES

$ npm run verify:specs
specs/index.json and the 6 vendored documents agree. 70 operations across the fleet.

$ npm run generate -- identity
generated 1 service(s) into src/services: identity

$ grep 'export const liveness' src/services/identity/sdk.gen.ts
(no match)
$ grep 'export const createWidget' src/services/identity/sdk.gen.ts
export const createWidget = … post({ url: '/v1/widgets', … })

$ node --test test/regeneration.test.mjs test/vendored-specs.test.mjs test/no-runtime-dependencies.test.mjs
# tests 29
# pass 29
# fail 0
```

**Every check in this repository passes over a client that has silently lost
`liveness`.** The sha256 is recomputed from the new bytes and written to the
index; `verify:specs` then agrees with itself; regeneration is a clean no-op
against the new tree; `regeneration.test.mjs` passes precisely *because* the
committed tree is what the pinned generator produces. A removal on its own does
fail loudly — the count moves and `expectOperations` refuses — so this is a hole
in one direction only, and that is the direction that matters.

`expectOperations` is a tripwire on a document's **size**. It is not a lock on
its surface. The README now says so, because a reader of the provenance section
would otherwise reasonably assume otherwise.

The real fix is a set rather than a count: a per-operation record in
`specs/index.json`, compared as a set on every verify. That is a schema change and
a migration of six entries, and I did not make it — see §8.

### 5.2 Does anything in CI know that `parlor` is written against this client?

**No, and the reason is stronger than "nobody checked".** `parlor` does not
depend on `cafaye-ts`.

```
$ grep -rn "cafaye-ts\|Cafaye" --include="*.ts" --include="*.tsx" --include="*.json" … 
(no matches)

$ node -e 'console.log(require("./package.json").dependencies)'
{ "@tanstack/react-query": "^5.104.0", "next": "16.3.7", "react": "19.2.8", "react-dom": "19.2.8" }
```

The brief's premise — "cafaye-ts is the client `parlor` itself calls" — does not
hold on either tree. `parlor` hand-writes its whole identity surface in
`src/lib/identity.ts`, and the file says why, in a comment I read rather than
inferred:

> They are NOT transcribed from `identity/openapi/v1.yaml`, because that document
> does not describe any of them. … Until it is, this file is the client half of a
> contract that has not been written down yet.

And it transcribes all ten, with the JSON shapes lifted from identity's Go
handler's `json:` struct tags. `parlor/src/lib/identity.ts:338-362`:

```ts
listAccounts:  (token) => send(transport, `${base}/v1/accounts`, "GET", { token }),
createAccount: (token, input) => send(transport, `${base}/v1/accounts`, "POST", { token, body: input }),
getAccount:    … `${base}/v1/accounts/${accountId}`, "GET" …
updateAccount: … "PATCH" …
deleteAccount: … "DELETE" …
listMembers:   … `${base}/v1/accounts/${accountId}/members`, "GET" …
invite:        … `${base}/v1/accounts/${accountId}/invitations`, "POST" …
acceptInvitation: … `${base}/v1/invitations/accept`, "POST" …
updateMember:  … `${base}/v1/accounts/${accountId}/members/${userId}`, "PATCH" …
removeMember:  … `${base}/v1/accounts/${accountId}/members/${userId}`, "DELETE" …
```

So the launch-scope product has an untyped, hand-transcribed copy of exactly the
ten operations the purchasable client lacks, and it knows it. Two consequences, and
neither is this repository's to fix:

1. **A method disappearing from this client would break nothing anywhere.** There
   is no consumer to break, and no CI in either repository that would notice.
   `test/customer-capability.test.mjs` is therefore not a regression net for
   `parlor`; it is a statement about the artifact a customer buys. Those are
   different jobs and conflating them would be a false claim about what the test
   does.
2. **When `identity` documents the ten, `parlor` has a migration to make** and
   nobody has written it down anywhere. The two deprecation surfaces now diverge.

### 5.3 Is there a typed error surface for a 404 from a method that does not exist?

**There is no such thing, and that is the honest answer rather than a gap in the
error hierarchy.** Two different failures, measured:

```
$ node -e "… await c.identity.createAccount({body:{name:'Acme'}}) …"
threw: TypeError | c.identity.createAccount is not a function
is CafayeError? TypeError undefined        <- status and code are both undefined
```

A method that does not exist never reaches the network, so there is no 404 to
type. A TypeScript consumer gets a **compile** error instead, which is better and
which I verified by compiling a consumer's file through the package name:

```
error TS2339: Property 'createAccount' does not exist on type
  'BoundNamespace<typeof import("…/dist/services/identity/index", …)>'.
error TS2551: Property 'createAccountInvitation' does not exist … Did you mean 'revokeAccountInvitation'?
```

A 404 from a method that **does** exist is typed, and typed correctly:

```
$ node -e "… await c.identity.listApiKeys({path:{account_id:'nope'}}) …"
a 404 from a method that EXISTS: CafayeNotFoundError | isCafayeError: true | status 404 | code not_found
```

The asymmetry is the cost: for a TypeScript customer the gap is a build failure
they will hit on their first attempt, and for a JavaScript one it is a `TypeError`
in their own code with no `CafayeError` anywhere to catch. Neither is silent, and
that is worth more than it sounds — but both are *late*, they land in the
customer's code rather than in ours, and nothing in this repository said so until
this packet. The README's new section is aimed at exactly that moment.

---

## 6. Courier

**The brief's question: which operations does a customer need to send a
transactional message, and can they? Yes, all three, and the check says so
rather than my report saying so.**

| Required | Generated as |
|---|---|
| `POST /v1/messages` | `sendMessage` |
| `POST /v1/webhook_endpoints` | `createWebhookEndpoint` |
| `POST /v1/webhook_endpoints/{id}/test` | `testWebhookEndpoint` |

`sendMessage`'s own document is unusually good about what it does and does not
promise, and it is worth quoting because a client generated from it inherits the
precision: a 200 means *the provider accepted the message for delivery and courier
wrote the `courier.email.delivered` outbox row in the same transaction*, it does
**not** mean the mail arrived, `data.status` therefore reads `accepted` and never
`delivered`, the send is synchronous so a 409 is a refusal the caller can act on
rather than a receipt for an intention, and the three refusals are told apart by
`code` and not by `detail`. The same paragraph says the platform's password
reset, email verification, email change and team invitation flows call this
operation and that until it existed "those endpoints were reachable-looking and
none of them could complete".

**Ten operations, six paths, and the document is complete against its own
router.** courier keeps `test/courier_web/openapi_document_test.exs`, which walks
`lib/courier_web/router.ex` and compares **paths**, not counts, in both
directions. Its only exclusion list is `GET /healthz` and `GET /readyz`, with the
reason written next to each, and a test asserts every exclusion still names a
route the router serves. There is no `knownDrift` and there does not need to be
one.

**What I found and did not fix, as instructed.**

- **courier-26 is two commits behind the vendored copy, and it changed the
  document.** `git diff 467cd3e..HEAD -- openapi.yaml` shows **no change to the
  operation set** and eight added `'503': Unavailable` responses — one on each
  operation behind `CourierWeb.Plugs.Principal`. That is a consequence of
  courier-26 making authentication a network hop to identity's introspection
  endpoint, so identity being unreachable is a fact about courier's deployment
  and a 503 rather than a 401. It is a *response* change, not a surface change,
  and the ten-operation answer above is unaffected.
- **The vendored copy is at `467cd3efb849a339b3dae9eadb3c6b9882fbc1b9`;
  courier's master is `ae8a660fd107…`.** Re-vendoring is
  `npm run vendor -- --service courier --bump` and nothing else — the operation
  count is unmoved, so `expectOperations` needs no edit.
- **The `error_relay` flake** is courier's own test suite and nothing to do with
  this client's surface. I did not run courier's suite: it needs Elixir, a
  database and a running stack, none of which `test/suite-is-offline.test.mjs`
  permits, and another packet is fixing it. I am reporting that I did not
  measure it rather than measuring it badly.
- **No message read-back.** `GET /v1/messages/{id}` does not exist in the
  document, because courier holds no delivery receipt and says so. A customer
  asking "what happened to the message I sent an hour ago" cannot ask courier, and
  that is a design decision rather than a gap — it is in the required set as a
  non-item.

---

## 7. The other finding: the gap is wider than tenancy, and the wider half is ours

The brief asked me to say so if I found it. I did, and it is the half of this
packet that is not somebody else's to fix.

**`identity` has two OpenAPI documents and this package vendors one per service.**

```
$ cd ../identity && ls openapi/*.yaml openid/*.yaml
openapi/v1.yaml
openid/openid.yaml
```

`openid/openid.yaml` holds **nine** operations:

```
GET   /.well-known/openid-configuration
GET   /.well-known/oauth-authorization-server
GET   /.well-known/jwks.json
GET   /oidc/authorize
GET   /oidc/authorize/callback
POST  /oidc/token
GET   /oidc/userinfo
GET   /oidc/login/{request_id}
POST  /oidc/login/{request_id}
```

The separation is **correct** and I want to be clear about that, because the
finding is easy to misread as a complaint about identity. RFC 8414 and OpenID
Connect Discovery fix the metadata and key paths at `/.well-known/…`, and core's
`docs/openapi-conventions.md` says every path in a cafaye service's contract is
under a single `/v1` prefix. One document would break one of the two rules. The
errors differ too — RFC 6749's `{"error": …}` on the OIDC surface, because an
off-the-shelf client library cannot parse a problem document and the entire point
of that surface is that one can. identity's drift test reads **both** documents
and treats the union as the contract, which is why its `knownDrift` is twelve
entries rather than twenty-one.

**The consequence lands here, and it is structural.** `specs/index.json` has one
`path` per service. `openapi-ts.config.ts` derives its service list from that
index and writes each service into `src/services/<service>/`. So this client has
**zero** of the OIDC protocol surface, and **no number of `npm run vendor -- --bump`
runs will ever change that** — the index has nowhere to put a second path and the
output directory has nowhere to put a second tree.

For a customer this means: a relying-party library reads
`/.well-known/openid-configuration` before it reads anything else, and there is
no typed way to get it from this package. Discovery, the JWKS a relying party
verifies an `id_token` against, the code-for-token exchange and userinfo are all
absent — and identity mints **JWKS-verified bearer JWTs** precisely so that the
verification key is published.

The fix is ours and it is not a documentation patch. It is:

1. key `specs/index.json` by **document** rather than by service — a
   `documents: []` array, or an `additionalDocuments` field per service, either
   way a schema change and a migration of six entries;
2. give `openapi-ts.config.ts` an **output directory per document**, because two
   documents for one service cannot share `src/services/identity/` — so
   `src/services/identity/v1/` and `src/services/identity/oidc/`, and a decision
   about what `cafaye-ts/services/identity` then means to a consumer;
3. decide what the wrapper exposes. `CafayeServices` has one property per service
   today, and the brief for that shape (`test/wrapper-class.test.mjs`) asserts the
   six names agree with the index — which is exactly the assumption this breaks.

That is an architectural change to how this package is laid out. It wants its own
packet and its own reviewed diff, and I did not start it here.

---

## 8. What is whose, without blurring it

### Not this repository's

**The ten tenancy operations.** `identity` serves all ten
(`internal/httpapi/accounts.go:561`, `registerTenancyRoutes`) and documents none.
Its own `internal/httpapi/openapi_drift_test.go` holds them in a `knownDrift` map
whose comment says the list "cannot grow and cannot be emptied", pinned at twelve
by `TestKnownDriftIsExactlyTheRoutesItClaimsToBe`, and its `cafaye.yml` carries
DECISION NEEDED **D1**:

> `exposes.api` names `openapi/v1.yaml`, and the first thing a consumer reads is
> this file: it promises a document describes this service's HTTP surface, and
> for twelve operations it does not.

Closing D1 means adding the ten to `openapi/v1.yaml` with operationIds and request
and response schemas, landing that, and re-vendoring here. **It is not a
documentation chore** — D1 is a decision in identity's `DECISIONS.md` and the
handler's `json:` tags are the shapes, so somebody has to choose which is the
contract.

**I did not hand-write `createAccount`.** Case 2 of the self-test is that fact,
demonstrated: two generated files edited, a method a consumer can call, and the
check still red with `absent-from-document` beside `it IS in the generated
client, as \`createAccount\``. The brief forbade it and the brief is right — a
method whose generated siblings are absent is a lie about what the document says,
and the next `npm run vendor` reverts it.

### This repository's

1. **The OIDC surface, structurally** (§7). A second document per service, an
   index keyed by document, an output directory per document, and a decision about
   the wrapper's shape. Ours, and the most consequential thing left undone.
2. **`expectOperations` is a count, not a set** (§5.1). A swap of one operation
   for another passes every check here. Fixing it means recording the operation
   *set* in `specs/index.json` and comparing sets on every verify and every
   vendor. I did not do it: it is a schema change to a file whose whole job is
   provenance, and it deserves its own diff.
3. **Nothing knew.** §5.2. The check exists now. What does not exist is any
   statement in any repository that this client is the launch-scope client, and
   the reason it does not exist is that `parlor` is not written against it — which
   is a finding for the manager, not a change I can make from here.
4. **The three stale README numbers** (§9). Fixed.
5. **Two latent defects in the gate self-test** (§9). Fixed; they were making
   `mise run gate-self-test` report a red that had nothing to do with `gate.yml`.

### A judgement call I made and would defend

**I did not re-vendor, though the brief's drift warning was live and the brief
allowed it.** `identity` is four commits behind its published head and
`identity-27` did change its document — the brief predicted exactly that. I
checked before deciding, and it does not move this finding:

```
$ git -C ../identity diff 793977b..HEAD -- openapi/v1.yaml | grep '^[+-]  version'
-  version: 1.5.0
+  version: 1.6.0

$ # operation SET, at identity@8337c52 against the vendored copy:
operations at identity@8337c52 : 31
operations in the vendored copy  : 31
in HEAD and not vendored: []
vendored and not in HEAD: []
```

`identity-27` removed a **409 response** from `POST /v1/email-verifications` — it
was an account-enumeration oracle, because that route declares `security: []` so
the 409 published "this address is proved" to a stranger — and the replacement is
`GET /v1/email-verification`, which requires a session. Same 31 operations, same
26 paths. The tenancy surface is absent at `8337c52` exactly as at the recorded
`793977b…`.

So re-vendoring would have moved a sha, a document version and a hundred generated
lines, and fixed nothing this packet measured. It is also a separate reviewed act
with its own CHANGELOG entry, and `courier-26` — which also changed its document,
eight 503s — is two commits behind for the same reason. **Both shas are recorded
in the CHANGELOG so the bump is a decision somebody makes on purpose**, with the
exact command. If the manager wants identity re-vendored anyway it is one command
and no `expectOperations` edit.

---

## 9. What else this packet found and fixed

**Three stale numbers in `README.md`.** The headline said **53** generated
operations; the table beneath it said 70, and the tree has 70. It was written
before cafaye-ts-01b added seventeen. The `specs/index.json` example quoted
`59247b6c65fd86a331a4f4bdcaf180ee1730687f` and `"operations": 8` for courier,
where the index says `467cd3efb849…` and `10`. And "**Your copy of `identity` is
behind**" was true when written — it named a packet in flight — and is now a
general statement with today's measurements (identity 4, courier 2, pantry 6
behind; billing, muse, darkroom current) on it.

**`test/readme-examples.test.mjs` located its table by a prefix, and the prefix
became ambiguous.** Its locator was "the first line starting with ``| `identity` ``",
and my new gap section has a row about identity's tenancy that comes first — so it
reported the README as claiming **10** operations where the index records **31**.
A real mismatch in the file and the wrong row entirely. A test that locates its
subject by a prefix will one day assert about a different table, loudly and
wrongly. It now finds the section by its heading, and it bounds the section to
that heading's own body — the first version of the new test counted **eight** rows
in "the gap table" because `split` on a heading returns everything after it. A
locator that reaches past the thing it is looking for is the same defect as one
that stops short of it.

**`test/gate_self_test.sh` was reporting a red that had nothing to do with
`gate.yml`, and had been for as long as it existed.** Every copy it makes runs the
whole suite, and `test/spec-drift.test.mjs` resolves the six cafaye checkouts
*relative to the repository it is running in*. A copy under `$TMPDIR` has no `../`
and no `../../cafaye`, so the drift test skipped eleven times — which failed
`suite-no-skip` **and** dropped `# pass` by eleven, which failed the floor:

```
# a copy of a repository whose own suite prints 208 passing and 0 skipped:
# tests 210  # pass 188  # fail 10  # skipped 11
```

Both fired on the control, and the self-test printed
`control: the gate really runs and the proofs appear` as RED against an unmodified
repository. It now hands every copy a `CAFAYE_WORKSPACE`, resolved by importing
this repository's own `scripts/lib/workspace.mjs` rather than by re-deriving the
search order — a second copy of that order is a second answer to "where is the
workspace", which is the exact drift that module exists to prevent.

**Its case 11 had been silently stale since cafaye-ts-01b.** It was
`edit "$repo/gate.yml" '      minimum: 187' '      minimum: 188'`, correct when 187
was the floor and wrong from the moment the floor became 201. A stale anchor exits
2 — but only *after* everything above it has printed green, so the run read as
fourteen passing cases. It now reads the live number and adds one, with `grep -Eo`
rather than `sed -n 's/…\+…/…/p'`, because BSD sed treats `\+` as a literal plus
and the case therefore only worked on Linux.

**Its case 13 and its control required a zero exit, which this packet makes
impossible.** Both are restated rather than quietly dropped: the control now
requires both count-bearing proofs satisfied **and** `gate.nonzero` to be the only
finding that fired, which is stronger than an exit-code check; case 13 keeps the
half that is still exactly true (`gate.floor` did not fire, `suite-no-skip` did)
and says at the case why the exit-code clause is gone. The self-test is now **17
passed, 0 failed**.

**`test/lib/dist.mjs` moved to `scripts/lib/dist.mjs`.** `scripts/capability.mjs`
needs the same built-package loader, and a script reaching into `test/` for its
own loader would make the test directory a library the shipped scripts depend on.
The old path stays as a re-export, so seven test files changed nothing.

---

## 10. The gate, honestly

```
$ ./bin/prime
==> node v22.19.0, npm 10.9.2
==> npm ci (frozen install, honours package-lock.json exactly
==> npm run typecheck (tsc --noEmit over src/, including the generated tree)
==> npm test
# tests 210
# suites 34
# pass 208
# fail 2
# cancelled 0
# skipped 0
$ echo $?
1
```

The two failures, by name:

```
not ok 1 - a customer can create an account, invite a member, accept the invitation, and obtain a session
not ok 2 - a customer can put this platform's sign-in on their own product
```

`gate.yml`'s `suite-pass` floor moved 201 → **208**, which is the seven new green
tests, because a floor left behind is a floor nobody notices has stopped
protecting anything. The paragraph beside it states what the two failures are, and
states that `test.skip` and a lowered floor are both the wrong repair. It also
records the honest limit of what a gate declaration can say here: there is no
proof shape for "exactly two failures, and here they are", because `# fail 0` as a
floor would go red the day `identity` documents the tenancy surface — the correct
direction, for a reason that reads like a regression. What holds the number instead
is `test/capability_self_test.sh`, whose control requires those two specific
findings and whose case 1 requires a document edit to close them.

**CI prints the reason rather than only the red.** `.github/workflows/ci.yml` runs
`npm run capability` and `bash test/capability_self_test.sh` after `bin/prime`,
both `if: always()` and `continue-on-error: true`. A red step that stops a job
tells a reader only that something failed; the fifteen operations, in order, with
the reason each is on a customer's path and whose it is, belong in the log rather
than in a report nobody opens. Both read the same
`scripts/lib/capability.mjs` the suite does, so the log and the assertions cannot
disagree about what is missing. The static half of core's checker is still green
over the edited declaration — `0 failure(s), 2 warning(s)`, both the deliberate
`gate.requirement-unproven`.

```
$ bash test/capability_self_test.sh
11 passed, 0 failed

$ bash test/gate_self_test.sh
17 passed, 0 failed

$ npm run verify:specs
specs/index.json and the 6 vendored documents agree. 70 operations across the fleet.

$ npm audit --audit-level=high
found 0 vulnerabilities
```

**What a green run still does not prove.** The tenancy check goes green when
`identity` documents the ten — and it will say green whether the shapes it
documents are the shapes the service serves, because a generated client inherits
whatever the document claims. `npm run e2e:identity` is the partial answer and it
is not in the gate, for the reason in its own header. And the OIDC check cannot go
green without the index shape change in §7, so that one stays red until somebody
does the architectural work.

---

## 11. Files changed

```
A  scripts/lib/capability.mjs          the required set, two measurements, four verdicts
A  scripts/capability.mjs              npm run capability
A  test/customer-capability.test.mjs   the gate-visible check; 6 green, 2 red on purpose
A  test/capability_self_test.sh        mise run capability-self-test
M  test/lib/dist.mjs                   now a re-export; the implementation moved
R  test/lib/dist.mjs -> scripts/lib/dist.mjs
M  scripts/lib/                        capability.mjs added
M  test/readme-examples.test.mjs       the table locator, and a check on the new gap table
M  test/gate_self_test.sh              the workspace, the stale floor recipe, the control, case 13
M  .github/workflows/ci.yml            two reporting steps that run when bin/prime is red
M  gate.yml                            minimum 201 -> 208, and what the two failures are
M  mise.toml                           the capability-self-test task
M  package.json                        npm run capability, npm run capability:self-test
M  README.md                           the gap section, and three stale numbers
M  AGENTS.md                           the customer path, the count-vs-set limit, the two fixes
M  CHANGELOG.md                        all of it, under Unreleased
A  REPORT-cafaye-ts-02b.md             this
```

Nothing under `src/services/` was touched, and `git diff --exit-code -- src/services`
is clean.

**A note on the report's name.** `REPORT-cafaye-ts-02.md` in this tree is a
*different* packet's report — the one that built the `Cafaye` class, merged as
`c93d44e` — and the packet number has been reused. I did not overwrite it. The
brief also referred to an untracked `REPORT-revendor.md` "belonging to an earlier
worker"; there is no such file on this tree and nothing untracked at all, so either
it was never written or it was cleaned up. Either way I read everything that was
here and deleted nothing.
