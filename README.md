# cafaye-ts

**The cafaye TypeScript client. One class, six services, typed errors.**

```ts
import { Cafaye } from 'cafaye-ts';

const cafaye = new Cafaye({ baseUrl: 'https://cafaye.example.com' });
const user = await cafaye.identity.getCurrentUser();
```

That is the whole integration. You name where the fleet is and, if you have one,
what to authenticate with; the class decides how to send the credential, applies
a deadline, and turns every failure into an exception you can `catch` by type.

Underneath it are 70 generated operations — a typed function per HTTP operation
across all six services, each carrying the specification's own prose, so your
editor can tell you what an endpoint is for without you leaving the code. You do
not import them. MD6's ruling was that generated code should stay an
implementation detail, so a generator upgrade can never break your build; this
is that ruling, in the shape you use.

It has **no runtime dependencies** and **emits no logs, no metrics and no
telemetry**. See [Credentials](#credentials) for why the second one is a guarantee
rather than a missing setting.

## Install

```sh
npm install cafaye-ts
```

Node 22.19 or newer. Nothing else — there is no `fetch` polyfill to install, no
HTTP client, and no dependency tree to audit. If you are self-hosting, your
runtime already has `fetch`.

## Where requests go

`baseUrl` is resolved once, in the constructor, and it is resolved for **all six
services**. In order:

| # | Source | Example |
|---|---|---|
| 1 | `baseUrl` as a record, the entry for that service | `{ baseUrl: { identity: '…' } }` |
| 2 | `baseUrl` as a string, for all six | `{ baseUrl: 'https://cafaye.example.com' }` |
| 3 | `CAFAYE_<SERVICE>_BASE_URL` | `CAFAYE_IDENTITY_BASE_URL` |
| 4 | `CAFAYE_BASE_URL` | one origin for all six |
| 5 | the host's own origin, `globalThis.location.origin` | a browser on the same origin |
| 6 | **throws** | nothing configured |

```ts
import { Cafaye } from 'cafaye-ts';

// One origin, behind your own reverse proxy. Simplest, and what most self-hosters want.
const one = new Cafaye({ baseUrl: 'https://cafaye.example.com' });

// Six hosts, named. A per-service entry beats the string.
const six = new Cafaye({
  baseUrl: {
    identity: 'https://identity.cafaye.example.com',
    billing: 'https://billing.cafaye.example.com',
    courier: 'https://courier.cafaye.example.com',
    darkroom: 'https://darkroom.cafaye.example.com',
    muse: 'https://muse.cafaye.example.com',
    pantry: 'https://pantry.cafaye.example.com',
  },
});

// In a browser application served from the same origin as the fleet, the host's
// own origin is the last source before the throw.
const browserApp = new Cafaye();
```

**There is no default, and no loopback fallback.** A client that guesses where to
send a customer's credentials is the failure this class exists to prevent, so step
six throws a `CafayeConfigurationError` that names every source it consulted and
suggests no host. A missing service in a partial record is reported at
construction rather than on the fifth call, naming the service.

A value that is not an absolute `http(s)` URL is refused: the generated transport
concatenates a base URL with a path rather than resolving one against the other,
so a bare host would produce something that is not a URL.

## Credentials

Hand the class whatever you were given. It works out which kind it is from the
shape, and sends it accordingly — you do not choose at each call site.

```ts
import { Cafaye } from 'cafaye-ts';

const baseUrl = 'https://cafaye.example.com';
const apiKey = 'cafaye_key';        // POST /v1/accounts/{account_id}/api_keys
const sessionToken = 'session';     // POST /v1/session
const jwt = 'a.b.c';                // the OIDC provider's token endpoint

// A scoped API token: `cafaye_` plus 32 bytes. The bearer header, and nothing else.
const machine = new Cafaye({ baseUrl, credentials: { token: apiKey } });

// A session token. The bearer header AND the `__Host-session` cookie, because
// identity accepts either and says it prefers the header when both are present.
const browser = new Cafaye({ baseUrl, credentials: { token: sessionToken } });

// A bearer JWT. The bearer header, and no cookie.
const service = new Cafaye({ baseUrl, credentials: { token: jwt } });

// No credential at all. Registering and signing in happen before there is one.
const anonymous = new Cafaye({ baseUrl });
```

`cafaye_` is the discriminator, and it is **identity's** discriminator —
`internal/httpapi/apikeys.go` calls it exactly that, and explains that the prefix
decides which of two tables is consulted without a query. This package reads the
same prefix for the same reason. Anything that is not a `cafaye_` token and is not
a JWS is a session token.

A credential can be replaced on a live client, which is what a long-running
process needs:

```ts
import { Cafaye } from 'cafaye-ts';

const cafaye = new Cafaye({ baseUrl: 'https://cafaye.example.com' });

cafaye.setCredentials({ token: 'cafaye_key' });
cafaye.setCredentials(null);
cafaye.credentialKind; // 'apiToken' | 'jwt' | 'session' | null
```

**Nothing is logged, ever.** Not at debug level, not behind an option, not to a
telemetry endpoint. This package is the one place in your application that touches
every credential it has, and `error.message` — which reaches a log file, a crash
reporter, a support ticket and a screen you are looking over someone's shoulder,
with no configuration — is the most likely thing in a Node process to carry one.
Emitting nothing is the only way to guarantee that for a library, because a debug
log is a log level somebody disables in production and pastes into a bug report.

Every string this package builds out of a service response, a header, a platform
error or a value you supplied goes through a redactor first, and the redactor is
**all or nothing**: a string comes back whole or comes back as
`[redacted: a credential-shaped value was present]`. A scrubber that removes what
it recognises and returns the rest invites a reader to add one more pattern, and
the day that pattern has a gap is the day a credential ships.
`test/wrapper-credential-leak.test.mjs` proves it, against a service that
deliberately echoes your token back at you.

## Errors

Every non-2xx from every cafaye service is `application/problem+json`
(RFC 9457). This class turns one into a typed exception.

```ts
import { Cafaye, CafayeUnauthenticatedError, CafayeValidationError, isCafayeError } from 'cafaye-ts';

const cafaye = new Cafaye({ baseUrl: 'https://cafaye.example.com' });
const email = 'someone@example.com';
const password = 'at least eight characters';

try {
  await cafaye.identity.registerUser({ body: { email, password } });
} catch (error) {
  if (error instanceof CafayeValidationError) {
    // core documents `errors[]` on a 422 and nowhere else
    for (const field of error.errors) console.error(`${field.field}: ${field.code}`);
  } else if (error instanceof CafayeUnauthenticatedError) {
    console.error('sign in again');
  } else if (isCafayeError(error)) {
    // every failure, including ones with no class of their own
    console.error(error.kind, error.status, error.code, error.traceId);
  } else {
    throw error;
  }
}
```

```
CafayeError                        kind: 'problem' | 'protocol' | 'network' | 'configuration'
├── CafayeProblemError             a problem document arrived
│   ├── CafayeUnauthenticatedError      401 unauthorized
│   ├── CafayeForbiddenError            403 forbidden
│   ├── CafayeNotFoundError             404 not_found
│   ├── CafayeRateLimitedError          429 rate_limited
│   ├── CafayeConflictError             409 conflict
│   │   └── CafayeIdempotencyKeyReusedError    409 idempotency_key_reused
│   └── CafayeValidationError           422 validation_failed
├── CafayeProtocolError            an HTTP response that is not what the contract says
├── CafayeNetworkError             no HTTP response at all
│   └── CafayeTimeoutError          the network failure was a timeout
└── CafayeConfigurationError       the options were wrong; no request was made
```

`CafayeProblemError` is instantiable, and it is the **fallback**. A code nobody
has heard of produces a `CafayeProblemError` carrying that code, not a bare
`Error` — a client that throws a bare `Error` on an unrecognised problem type has
moved the problem, not solved it. `code` chooses the class and `status` breaks
the tie, because core calls `type` the machine-readable contract and RFC 9457
makes `status` advisory.

`isCafayeError` recognises an error from a **second copy** of this package, which
`instanceof` does not: two versions in one dependency tree give two constructors
and the failure looks like a bug in your error handling.

### The three decisions worth knowing

**A response that is not a problem is not a problem.** A 502 from a reverse proxy
is a failure, and it is a `CafayeProtocolError`: a status, a `Content-Type`, and a
short redacted excerpt of the body, because a proxy's HTML is undiagnosable
without one. It has no cafaye `code`, because inventing one would be a lie.

**A problem-shaped body with a 200 is not a success.** It throws a
`CafayeProtocolError`. The alternative is handing you a `Problem` where the types
promised a `User` — a `TypeError` three frames from the mistake, instead of a
diagnosis at it. Nothing in the six documents' success schemas has `type`,
`title` and `status` together, so the check has no false positive against the
current fleet.

**A network failure is not an HTTP error and has no status.** One type covers both
cases, with the distinction queryable: `kind` is `'problem' | 'protocol' |
'network' | 'configuration'`, and `status` is `null` for everything that did not
come with an HTTP response. So the common handler is `error.status !== null`
rather than an `instanceof` ladder — and a caller who does care can still branch
on `instanceof CafayeNetworkError`.

**A timeout is not a DNS failure.** `CafayeTimeoutError` extends
`CafayeNetworkError`, so `catch (e) { if (e instanceof CafayeNetworkError) … }`
catches both, and `reason` tells them apart:

```ts
import { CafayeNetworkError, CafayeTimeoutError } from 'cafaye-ts';

function describe(error: CafayeNetworkError): string {
  // 'timeout' | 'aborted' | 'dns' | 'connection' | 'tls' | 'unknown'
  if (error instanceof CafayeTimeoutError) return 'the deadline passed';
  return error.reason;
}
```

`aborted` is the caller's own `AbortSignal` firing, which is not a failure of
anything and must not be retried by a wrapper that does not know whose signal it
was. `unknown` means this package could not tell — most often a custom `fetch` of
your own, or `timeoutMs: 0` with a custom abort reason.

## Timeouts

One request may take `timeoutMs`, thirty seconds by default. `0` disables it. The
deadline is installed per request with an unref'd timer, so it cannot hold a Node
process open, and it is cleared when the request finishes.

```ts
import { Cafaye } from 'cafaye-ts';

const cafaye = new Cafaye({ baseUrl: 'https://cafaye.example.com', timeoutMs: 5_000 });
```

## What you cannot do through this client yet

**Read this before you plan an integration.** A generated client is exactly as
capable as the documents it was generated from, and two of the fleet's surfaces
are not in those documents. Both are measured, and `npm run capability` prints
the current answer:

```sh
npm run capability     # exits nonzero while anything is missing
```

| What is missing | How many | Whose it is |
|---|---:|---|
| `identity` tenancy — create/list/read/rename/delete an account, invite a member, accept an invitation, list and change members | 10 | `identity`. The service **serves** all ten; its OpenAPI document describes none of them, so no amount of re-vendoring produces a method. |
| `identity`'s OpenID Connect provider surface — discovery, JWKS, token, userinfo, authorize | 5 | **This package.** They *are* documented, in a second document (`openid/openid.yaml`) that this package does not vendor. |

**What that means in practice.** You can register a user and sign them in. You
cannot give them a team to work in: there is no `createAccount`, no
`createAccountInvitation`, no `acceptInvitation`, and no `listAccountMembers`.
`mintApiKey` and `registerOidcClient` both take an `account_id` in the path, so
they exist and are unreachable. If you are integrating this for a single user,
you are fine. If you are integrating it for an organisation, you are not, and no
amount of reading this package's types will tell you so — a missing method is a
compile error, not a runtime one, and a `TypeError` at runtime if you are in
JavaScript.

**There is no workaround here and there is not going to be one.** Reach for
`fetch` against the routes above if you need them today, exactly as you would
have before this package existed. Do not expect a typed method to appear without
`identity` documenting the operations first.

**Why this section exists at all.** `test/customer-capability.test.mjs` asserts
the same thing inside the gate, and it is **failing on purpose** — fifteen
operations, named one by one, with the reason each one is on a customer's path.
`REPORT-cafaye-ts-02b.md` has the measurements, including what closing each half
takes and who owns it.

## What is in the box

| Service | Operations | Paths | Document version |
|---|---:|---:|---|
| `identity` | 31 | 26 | 1.5.0 |
| `billing` | 15 | 11 | 1.3.0 |
| `muse` | 1 | 1 | 1.1.0 |
| `darkroom` | 9 | 7 | 1.0.0 |
| `pantry` | 4 | 4 | 1.1.0 |
| `courier` | 10 | 6 | 2.2.0 |
| **total** | **70** | | |

All six documents are OpenAPI 3.1. The counts are measured from the documents
themselves and asserted by the test suite; if a service's document changes size,
this table and the suite change together or the suite fails.

`cafaye.<service>.<operation>` returns the operation's **data**, not the generated
envelope, and a failure is a thrown exception. Underneath, each service also still
exports a factory and its own types:

```ts
import { createClient } from 'cafaye-ts/services/identity/client';
import { getCurrentUser, type Problem } from 'cafaye-ts/services/identity';

const client = createClient({ baseUrl: 'https://identity.example.com' });
const { data, error } = await getCurrentUser({ client });
//   data:  User | undefined
//   error: Problem | undefined   — identity's RFC 9457 problem document
```

That is the raw transport, and it is the alternative rather than the front door:
the envelope is a second thing to destructure at every call site, `error` is a
bare object rather than an `Error` and carries no stack, and `throwOnError: true`
throws whichever of the two `JSON.parse` produced. Reach for it when you want
that; the wrapper exists so you do not have to.

**There is deliberately no pre-built client to grab.** The generated code does
export a `client` const pre-pointed at each service's documented production URL,
and it is not reachable from any of these entrypoints on purpose: a self-hoster
who reached for it would send their traffic to the public SaaS. `Cafaye` throws
rather than fall back to it.

### One escape hatch

`cafaye.rawClient('courier')` returns a service's own generated client, with this
class's base URL and credential already on it, for a route the documents do not
describe:

```ts
import { Cafaye } from 'cafaye-ts';

const cafaye = new Cafaye({ baseUrl: 'https://cafaye.example.com' });
const courier = cafaye.rawClient('courier');
```

The name says what it costs: **errors from `rawClient` are not typed.** You get
the generated envelope. The bound namespaces are the front door; this is a door
for the routes the documents have not caught up with.

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
  "commit": "467cd3efb849a339b3dae9eadb3c6b9882fbc1b9",
  "operations": 10,
  "sha256": "bfb2eff04dcd739..."
}
```

A vendored document with no sha is a rumour. That is the whole reason the index
exists, and it is why the test suite refuses to pass if a vendored file's bytes
stop matching what the index says.

**The count in the index is a count, not a set.** `expectOperations` catches a
document that changed size, which is the common case and the one worth a hard
stop. It does **not** catch a document that loses one operation and gains another:
the count is unmoved, the sha256 is recomputed by the vendor, every check in this
repository passes, and a client has silently lost a method. Measured on this
tree — that swap is a real experiment, in `REPORT-cafaye-ts-02b.md` §5. The
`expectOperations` field exists and this is what it is worth; read it as a
tripwire on size, not as a lock on surface.

**Your copy of a service can be behind, and how far is printed on every test
run.** This package is rebuilt from the documents deliberately, by a human, in a
reviewable diff — not continuously — so the recorded `commit` for any service can
be behind that service's published head. Measured on 2026-10-02: `identity` four
commits behind, `courier` two, `pantry` six, and `billing`, `muse` and `darkroom`
current. A copy more than nine commits behind fails the suite, with the one
command that closes it; below that it is reported on every run. If you need a
service's newest routes, check its `commit` above against the identity you have
deployed, and either `npm run vendor -- --service <name> --bump` from a checkout
or build from source.

## What this is deliberately not

**Nothing here composes two services.** No convenience method that registers a
user and then creates their account, no pagination helper, no token refresh, no
retry, no cache. Each of those is a place to put a policy the platform should own,
and putting one in the client would make the fleet's current shape a thing your
application code depends on. MD6 named four responsibilities for the hand-written
client, and this class has those four.

**No telemetry, and none planned.** If you want traces, instrument the `fetch` you
pass in. That is what the `fetch` option is for, and it keeps the decision yours
rather than making it for you inside a library that touches every credential you
have.

**Not a validator of service responses.** The generated types come from the
documents; a service that drifts from its own document produces a wrong value
shaped like a right one, and fixing that here would mean a runtime schema library
and a dependency tree — which MD6 rules out and which
`test/no-runtime-dependencies.test.mjs` enforces.

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
  wind-down on 2026-05-18 and left every consumer holding a version range that no
  longer meant anything.
- **`typescript` is pinned to 5.9.3, also exactly.** TypeScript 7 removed a
  compiler API the generator's transformers use. The generator declares
  `peerDependencies: { typescript: ">=5.5.3 || >=6.0.0" }`, and TypeScript 7.0.2 —
  npm's current `latest` — *satisfies that range*. With it installed the generator
  does not warn and does not degrade; it crashes before reading a document. The
  declared peer range does not protect you. Only the pin does, and
  `test/no-runtime-dependencies.test.mjs` is its tripwire.

## License

MIT. See [LICENSE](LICENSE).
