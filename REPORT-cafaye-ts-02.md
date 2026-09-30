# REPORT — cafaye-ts-02, the hand-written `Cafaye` class

Branch `worker/cafaye-ts-02`, seven commits on top of `8b06982`. Gate: **187
pass, 0 fail, 0 skipped** (baseline was 67). No new runtime dependency. Nothing
under `src/services/` was touched, and `specs/index.json` still carries the shas
it did.

---

## 1. What I built, and the file list

MD6 named three things the hand-written class owns — credential handling,
base-URL resolution, RFC 9457 mapping — and one structural thing it is: the
public surface, so that "generated code stays an implementation detail, so a
generator upgrade can never break the public API". This is that class. Four
files and a half of prose, and the prose is most of the work.

### Source (new, hand-written — 1,998 lines)

| File | Lines | What it is |
|---|---:|---|
| `src/cafaye/class.ts` | 699 | **The class.** Options, base-URL resolution for all six at construction, per-request credential attachment, the deadline, the six bound namespaces, `setCredentials`, `rawClient`, and the one place a failure becomes an exception. |
| `src/cafaye/errors.ts` | 712 | The exception hierarchy, `code`-to-class mapping, the network-failure classifier, and the two contract-edge decisions. |
| `src/cafaye/base-url.ts` | 208 | `resolveBaseUrl` and its six-step order, `baseUrlEnvFor`, `BASE_URL_ENV`. |
| `src/cafaye/redact.ts` | 170 | `createRedactor` (all-or-nothing) and `safeCause`. |
| `src/cafaye/credentials.ts` | 160 | `classifyCredential`, `attachCredential`, `API_TOKEN_PREFIX`, `SESSION_COOKIE_NAME`. |
| `src/cafaye/services.ts` | 114 | The six generated namespaces, imported exactly once, plus `serviceNames` and the six `createClient` factories. |
| `src/index.ts` | 96 (rewritten) | `Cafaye`, the thirteen error classes, `isCafayeError`, the constants, the six namespaces, `serviceNames`. |

### Tests (new — 2,965 lines; 121 assertions added to the suite)

| File | Lines | Covers |
|---|---:|---|
| `test/wrapper-credential-leak.test.mjs` | 718 | The brief's most important constraint. 14 tests, quoted in full in §3. |
| `test/wrapper-class.test.mjs` | 870 | The class through the real generated transport with an injected `fetch`: exact wire headers, the six namespaces, every failure path, the fake clock, and the six-names tripwire. |
| `test/wrapper-errors.test.mjs` | 472 | The hierarchy, `code`-first mapping, `code → status` fallback, extensions, the typed fallback, both contract edges, and the four network reasons. |
| `test/wrapper-base-url.test.mjs` | 324 | One test per precedence step, the ladder in one assertion, and the "never silently defaults" set. |
| `test/wrapper-types.test.mjs` | 215 | Compiles a probe that uses the wrapper as a consumer would. |
| `test/wrapper-credential-classification.test.mjs` | 149 | The three-way discriminator and header-injection refusal. |
| `test/wrapper-redaction.test.mjs` | 149 | The scrubber, including the cases a too-eager scrubber would fail. |
| `test/lib/dist.mjs` | 68 | Builds on demand, so any wrapper test file runs alone. |

### Docs (modified)

`README.md` rewritten around the wrapper (every TypeScript example is compiled by
the existing test). `AGENTS.md` gains a **Rules for the hand-written half**
section. `CHANGELOG.md` gains Added / Changed / Deliberately-not-built under
`Unreleased`. `test/readme-examples.test.mjs` is modified — see §7.

---

## 2. The gate

```
$ bin/prime
==> npm ci        (frozen, honours package-lock.json)
==> npm run typecheck   (tsc --noEmit over src/, including src/cafaye/)
==> npm test

# tests 187
# suites 28
# pass 187
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`npm pack --dry-run`: 211 files, no `test/`, no `scripts/`, no `bin/`, no
`tsconfig`, no `.github/`, no source maps, `specs/index.json` present, all six
`dist/services/<name>/index.{js,d.ts}` present, plus the six new
`dist/cafaye/*.js`. **No new runtime dependency** — `dependencies` is still `{}`
and the class uses `atob`, `JSON.parse`, `URL`, `AbortController`,
`setTimeout` and `Headers`.

No sleeps, no raised retries, no loosened assertions. The deadline tests run on
`node:test`'s mock timers; the only `await` on a macrotask anywhere is
`setImmediate`, which is a yield with no interval to be late against. The offline
check in `suite-is-offline.test.mjs` is untouched and still passes — its
`fetch(` rule fired once on a *comment* of mine describing the generated
transport's behaviour, and I reworded the comment rather than weaken a standing
check.

---

## 3. The credential-leak test, verbatim, and what it asserts

This is §4 of `test/wrapper-credential-leak.test.mjs`, the three helpers, and
§5's single assertion. The behavioural half is the part that matters; the
helper is included because what it asserts is inseparable from how.

### What it asserts, in one line

**A token string appears in no log record, in no exception message, in no
stack, in no `cause` chain, in no own property, and in no serialised form — and
the package emits nothing at all.**

### The design decision that makes it worth anything

The test is **adversarial, not innocent**. Each failure path is fed a service or
a gateway that has *deliberately put a credential into the response*. An
innocent `assert(!error.message.includes(TOKEN))` would pass against all of
those being absent, and would prove nothing about the ones that are present.

It also walks **every own property, enumerable or not, symbol-keyed included**,
plus `stack`, `String()`, `JSON.stringify()` and the `cause` chain. That is not
paranoia about `message`: `CafayeProblemError.detail` is a plain enumerable field
carrying server-controlled prose, and it is the single most likely place for a
service to echo a caller's own credential back — and it is in
`JSON.stringify(err)`.

### The test bodies

Verbatim, extracted from the file:

```js
describe('no credential reaches a log, a message, or a serialised form', () => {
  it('a service echoing the token back in `detail` does not get it into the exception', async () => {
    // The realistic version of the attack. A service that includes a submitted
    // value in its error prose is not a hypothetical bug; it is the most common
    // way a credential ends up in a log. `detail` is core's "specific to this
    // occurrence" field, so it is server-authored and untrusted.
    for (const [credential, token] of [
      ['apiToken', API_TOKEN],
      ['session', SESSION_TOKEN],
      ['jwt', JWT_TOKEN],
    ]) {
      const cafaye = new Cafaye({
        baseUrl: 'https://cafaye.example.com',
        fetch: transport(() =>
          problemResponse(
            problem({
              code: 'validation_failed',
              status: 422,
              detail: `the submitted value ${token} is not acceptable`,
              errors: [{ field: 'token', code: 'rejected', value: token }],
            }),
            422,
          ),
        ),
        credentials: { token },
      });

      await captureOutput(async () => {
        const error = await cafaye.identity.getCurrentUser().then(
          () => assert.fail('the call was expected to fail'),
          (e) => e,
        );
        assertNoCredential(error, token, `${credential} in a 422 detail`);
      });
    }
  });

  it('a credential in an extension member does not get through either', async () => {
    // RFC 9457 explicitly permits extension members, so a service may put
    // anything in one. This package copies unknown members onto `extensions`
    // because a client that dropped them would lose a field a service added
    // yesterday — which makes the redactor's job on that path load-bearing.
    const cafaye = new Cafaye({
      baseUrl: 'https://cafaye.example.com',
      fetch: transport(() =>
        problemResponse(
          problem({
            code: 'conflict',
            status: 409,
            attempted_token: SESSION_TOKEN,
            nested: { deeper: [`Bearer ${API_TOKEN}`], count: 1 },
          }),
          409,
        ),
      ),
      credentials: { token: SESSION_TOKEN },
    });

    await captureOutput(async () => {
      const error = await cafaye.identity.getCurrentUser().then(
        () => assert.fail('the call was expected to fail'),
        (e) => e,
      );
      assert.equal(error.extensions.nested.deeper[0], '[redacted: a credential-shaped value was present]');
      assertNoCredential(error, SESSION_TOKEN, 'a credential in an extension member');
      assertNoCredential(error, API_TOKEN, 'a second credential in an extension member');
    });
  });

  it('a credential in a response header does not get through', async () => {
    // A `Set-Cookie` on a response this class did not authenticate, and a header
    // the class never reads. It is asserted because the obvious way to make a
    // protocol error useful is to quote the response, and a response can carry a
    // credential in a header.
    const cafaye = new Cafaye({
      baseUrl: 'https://cafaye.example.com',
      fetch: transport(() =>
        new Response('<html><h1>502 Bad Gateway</h1></html>', {
          status: 502,
          headers: {
            'content-type': 'text/html',
            'set-cookie': `__Host-session=${SESSION_TOKEN}; Path=/; Secure; HttpOnly`,
            'x-echoed-authorization': `Bearer ${API_TOKEN}`,
          },
        }),
      ),
      credentials: { token: SESSION_TOKEN },
    });

    await captureOutput(async () => {
      const error = await cafaye.identity.getCurrentUser().then(
        () => assert.fail('the call was expected to fail'),
        (e) => e,
      );
      assert.equal(error.status, 502);
      assertNoCredential(error, SESSION_TOKEN, 'a credential in a Set-Cookie header');
      assertNoCredential(error, API_TOKEN, 'a credential in a response header');
    });
  });

  it('a credential in a proxy error page does not get through', async () => {
    // The all-or-nothing rule, observed: the excerpt is either the whole thing or
    // nothing, and when there is a credential in it there is nothing.
    const cafaye = new Cafaye({
      baseUrl: 'https://cafaye.example.com',
      fetch: transport(
        () =>
          new Response(
            `<html><body><p>upstream rejected Authorization: Bearer ${JWT_TOKEN}</p></body></html>`,
            { status: 503, headers: { 'content-type': 'text/html' } },
          ),
      ),
      credentials: { token: JWT_TOKEN },
    });

    await captureOutput(async () => {
      const error = await cafaye.identity.getCurrentUser().then(
        () => assert.fail('the call was expected to fail'),
        (e) => e,
      );
      assert.equal(error.bodySnippet, null, 'part of the page survived redaction');
      assertNoCredential(error, JWT_TOKEN, 'a credential in a proxy error page');
    });
  });

  it('a credential in a network failure message does not get through, and the cause is withheld', async () => {
    // The one place a caller-controlled string reaches a message this package
    // builds: a `fetch` the consumer supplied. undici's own messages are a
    // hostname, a port and an errno, but a custom transport can say anything, and
    // Node prints a `cause` chain in `console.error(err)` and in every crash
    // reporter. So the original cause is withheld ENTIRELY rather than scrubbed:
    // a partly-scrubbed cause would be an object that is no longer the platform's
    // carrying a message that is no longer true.
    const cafaye = new Cafaye({
      baseUrl: 'https://cafaye.example.com',
      fetch: transport(() => {
        throw Object.assign(new TypeError(`fetch failed: no route to ${SESSION_TOKEN}.example.com`), {
          cause: Object.assign(new Error(`dial tcp: token=${API_TOKEN}`), { code: 'ENOTFOUND' }),
        });
      }),
      credentials: { token: SESSION_TOKEN },
    });

    await captureOutput(async () => {
      const error = await cafaye.identity.getCurrentUser().then(
        () => assert.fail('the call was expected to fail'),
        (e) => e,
      );
      assert.equal(error.reason, 'dns');
      // The errno survives, because it is what a handler branches on — and it
      // survives on the error itself, which is where a caller reads it, rather
      // than only two levels down a cause chain that has just been withheld.
      assert.equal(error.code, 'ENOTFOUND');
      assert.equal(error.cause.name, 'TypeError', 'the withheld cause kept the name');
      assert.equal(error.cause.cause, undefined, 'the withheld cause kept a chain of its own');
      assertNoCredential(error, SESSION_TOKEN, 'a credential in a network error message');
      assertNoCredential(error, API_TOKEN, 'a credential in a network error cause');
    });
  });

  it('keeps a clean cause intact, so the errno chain survives', async () => {
    // The other half of the previous test, and the reason the previous one is not
    // simply "never keep a cause": a redactor that withholds everything is not a
    // redactor, it is a bonfire, and it would make every network error
    // undiagnosable. The real `ENOTFOUND` shape Node produces is kept untouched.
    const platformCause = Object.assign(new Error('getaddrinfo ENOTFOUND identity.example.com'), {
      code: 'ENOTFOUND',
    });
    const platformError = Object.assign(new TypeError('fetch failed'), { cause: platformCause });
    const cafaye = new Cafaye({
      baseUrl: 'https://cafaye.example.com',
      fetch: transport(() => {
        throw platformError;
      }),
      credentials: { token: SESSION_TOKEN },
    });

    await captureOutput(async () => {
      const error = await cafaye.identity.getCurrentUser().then(
        () => assert.fail('the call was expected to fail'),
        (e) => e,
      );
      assert.equal(error.cause, platformError, 'a clean platform error was replaced');
      assert.equal(error.cause.cause, platformCause);
      assert.equal(error.cause.cause.code, 'ENOTFOUND');
    });
  });

  it("a credential in a caller's own abort reason does not get through", async () => {
    // A distinct path from the one above, and the one most likely to be forgotten:
    // this class composes the caller's `AbortSignal` with its own, and the reason
    // the rejection carries is one this class chose rather than the caller's — so
    // that a caller who aborts with an error of their own, which is the documented
    // way to say why they stopped, still gets a `reason: 'aborted'` rather than
    // something unclassifiable. The caller's reason is kept, as a `cause`, after
    // the same redactor.
    //
    // The default `timeoutMs` is used on purpose. With `timeoutMs: 0` this class
    // composes nothing and passes the caller's signal straight through, so a
    // custom abort reason is genuinely indistinguishable from any other rejection
    // and `reason` is `'unknown'` — documented in `errors.ts`, and asserted in
    // `wrapper-errors.test.mjs` for the shapes that ARE recognisable.
    const cafaye = new Cafaye({
      baseUrl: 'https://cafaye.example.com',
      credentials: { token: SESSION_TOKEN },
      fetch: transport(
        (request) =>
          new Promise((_resolve, reject) => {
            if (request.signal.aborted) {
              reject(request.signal.reason);
              return;
            }
            request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
          }),
      ),
    });

    const controller = new AbortController();
    const pending = cafaye.identity.getCurrentUser({ signal: controller.signal });
    controller.abort(
      Object.assign(new Error(`the user navigated away; draft was ${API_TOKEN}`), { code: 'ABORT_ERR' }),
    );

    await captureOutput(async () => {
      const error = await pending.then(
        () => assert.fail('the call was expected to fail'),
        (e) => e,
      );
      assert.equal(error.reason, 'aborted');
      assertNoCredential(error, API_TOKEN, "a credential in a caller's abort reason");
    });
  });

  it('a credential on the timeout path does not get through', async (t) => {
    // The class's OWN deadline, driven by a fake clock. The value that could leak
    // here is the one the class puts in the abort reason — a `CafayeTimeoutError`
    // whose message the class composed — and the assertion is that it composed one
    // without a credential in it, having been handed one.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const cafaye = new Cafaye({
        baseUrl: 'https://cafaye.example.com',
        timeoutMs: 30_000,
        credentials: { token: SESSION_TOKEN },
        fetch: transport(
          (request) =>
            new Promise((_resolve, reject) => {
              if (request.signal.aborted) {
                reject(request.signal.reason);
                return;
              }
              request.signal.addEventListener('abort', () => reject(request.signal.reason), {
                once: true,
              });
            }),
        ),
      });

      const pending = cafaye.identity.getCurrentUser();
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(30_000);

      const { value, written } = await captureOutput(() =>
        pending.then(
          () => assert.fail('the call was expected to time out'),
          (e) => e,
        ),
      );
      assert.equal(value.name, 'CafayeTimeoutError');
      assert.deepEqual(written, [], `the timeout path wrote:\n${written.join('\n')}`);
      for (const credential of CREDENTIALS) {
        assertNoCredential(value, credential, 'the timeout error');
      }
    } finally {
      t.mock.timers.reset();
    }
  });

  it('a credential in a configuration error does not get through', async () => {
    // The rejected value IS the credential, so a configuration error that quotes
    // what it rejected has published it. This is why `classifyCredential`'s
    // message describes the problem and never the value.
    //
    // The value used here is a real credential with a NUL appended: it is
    // credential-shaped, so a scrubber that printed it would print a token, and
    // it is rejected, so the message is the only place it could have appeared.
    // A blank or whitespace-only value is NOT used, because "three spaces" is
    // found in every stack trace ever printed and the assertion would be about
    // the walker's sensitivity rather than about a leak.
    for (const name of ['CAFAYE_BASE_URL', ...serviceNames.map((s) => `CAFAYE_${s.toUpperCase()}_BASE_URL`)]) {
      delete process.env[name];
    }
    const cafaye = new Cafaye({
      baseUrl: 'https://cafaye.example.com',
      fetch: transport(() => new Response('{}', { status: 200 })),
    });
    const tainted = `${API_TOKEN}\u0000`;

    await captureOutput(async () => {
      let error;
      try {
        cafaye.setCredentials({ token: tainted });
      } catch (e) {
        error = e;
      }
      assert.ok(error, `setCredentials accepted a credential containing a NUL`);
      assertNoCredential(error, tainted, 'a rejected credential in a configuration error');
      assertNoCredential(error, API_TOKEN, 'the credential part of a rejected credential');
    });
  });

  it('the happy path writes nothing and holds nothing readable', async () => {
    // The positive case, and it is the one that would be missed by a test that
    // only inspects failures: a successful call with a credential on it is the
    // most ordinary thing this package does, and it must produce no output and
    // expose no credential on the instance.
    const cafaye = new Cafaye({
      baseUrl: 'https://cafaye.example.com',
      fetch: transport(
        () => new Response(JSON.stringify({ id: 'usr_1' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
      credentials: { token: SESSION_TOKEN },
    });

    const { value, written } = await captureOutput(() => cafaye.identity.getCurrentUser());
    assert.equal(value.id, 'usr_1');
    assert.deepEqual(written, [], `a successful call wrote ${written.length} record(s):\n${written.join('\n')}`);

    assert.equal(cafaye.credentialKind, 'session');
    for (const credential of CREDENTIALS) {
      assertNoCredential(cafaye, credential, 'the client instance itself');
    }
  });

  it('writes nothing on any path, ever', async (t) => {
    // The single broad assertion, over every failure mode the class has, because
    // a per-path assertion can be forgotten when a path is added. One loop, one
    // capture, one list of paths — and the list is the inventory a reader can
    // check against `src/cafaye/`.
    const cafaye = new Cafaye({
      baseUrl: 'https://cafaye.example.com',
      credentials: { token: SESSION_TOKEN },
    });

    const paths = {
      success: () => new Response(JSON.stringify({ id: 'usr_1' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      problem: () => problemResponse(problem({ code: 'unauthorized', status: 401 }), 401),
      'problem on a 200': () => problemResponse(problem({ code: 'internal' }), 200),
      'protocol error': () => new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
      'no content type': () => new Response('gateway said no', { status: 504 }),
      network: () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      },
    };

    for (const [name, reply] of Object.entries(paths)) {
      const client = new Cafaye({
        baseUrl: 'https://cafaye.example.com',
        credentials: { token: SESSION_TOKEN },
        fetch: transport(reply),
      });
      const { written } = await captureOutput(() =>
        client.identity.getCurrentUser().then(
          () => 'resolved',
          (e) => `threw ${e.name}`,
        ),
      );
      assert.deepEqual(written, [], `the ${name} path wrote ${written.length} record(s):\n${written.join('\n')}`);
    }

    // And a deadline that fires, which is the last path that constructs a message.
    // Driven by the fake clock rather than by a real one, for the reason the
    // timeout test above gives: a real thirty-second timer is a wait, and a wait
    // in a suite is a flake waiting for a busy machine.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let timedOut;
    try {
      const aborting = new Cafaye({
        baseUrl: 'https://cafaye.example.com',
        credentials: { token: SESSION_TOKEN },
        timeoutMs: 30_000,
        fetch: transport(
          (request) =>
            new Promise((_resolve, reject) => {
              if (request.signal.aborted) {
                reject(request.signal.reason);
                return;
              }
              request.signal.addEventListener('abort', () => reject(request.signal.reason), {
                once: true,
              });
            }),
        ),
      });
      const pending = aborting.identity.getCurrentUser();
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(30_000);
      timedOut = await captureOutput(() =>
        pending.then(
          () => 'resolved',
          (e) => `threw ${e.name}`,
        ),
      );
    } finally {
      t.mock.timers.reset();
    }
    assert.deepEqual(timedOut.written, [], `the timeout path wrote:\n${timedOut.written.join('\n')}`);
    assert.match(String(timedOut.value), /CafayeTimeoutError/);

    // And a configuration error, which happens before a request exists.
    for (const name of ['CAFAYE_BASE_URL', ...serviceNames.map((s) => `CAFAYE_${s.toUpperCase()}_BASE_URL`)]) {
      delete process.env[name];
    }
    const unconfigured = await captureOutput(() => {
      try {
        new Cafaye();
        return 'did not throw';
      } catch (e) {
        return `threw ${e.name}`;
      }
    });
    assert.deepEqual(unconfigured.written, []);
    assert.match(String(unconfigured.value), /CafayeConfigurationError/);

    // `cafaye` itself is constructed and unused above on purpose: a class whose
    // constructor logs is the failure this whole test exists to prevent, and it
    // would be found here.
    assert.ok(cafaye.credentialKind === 'session');
  });
});
```

### The two helpers it runs on

```js
/**
 * Every string reachable from a thrown value, however a log formatter would find
 * it.
 *
 * The union of what `console.error(err)`, `JSON.stringify(err)` and
 * `util.inspect(err)` each reach — deliberately overlapping rather than
 * exhaustive-by-listing, because the point is to be blunt. Own properties are
 * walked whether or not they are enumerable, and symbol-keyed ones too, since a
 * brand that leaks is still a leak.
 */
function stringsIn(value, seen = new Set(), out = []) {
  if (value === null || value === undefined) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (typeof value !== 'object') {
    out.push(String(value));
    return out;
  }
  if (seen.has(value)) return out;
  seen.add(value);

  out.push(String(value));
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || typeof descriptor.get === 'function') continue;
    // Read through the descriptor rather than `value[key]`, so a throwing getter
    // cannot turn a leak assertion into an unhandled rejection — and so a getter
    // that hides a credential cannot hide it from this.
    try {
      stringsIn(descriptor.value, seen, out);
    } catch {
      /* a property that cannot be read is a property that cannot leak */
    }
  }
  return out;
```

```js
/**
 * Assert that a credential appears nowhere in anything a logger could reach.
 *
 * The message names the path so that a failure says WHICH credential and WHICH
 * surface, because "expected the string not to be found somewhere" is the least
 * useful failure message a leak test can produce.
 */
function assertNoCredential(value, credential, where) {
  if (credential === '' || credential === undefined) return;

  const found = stringsIn(value).filter((s) => s.includes(credential));
  if (found.length > 0) {
    assert.fail(
      `a credential reached the surface reachable from the ${where}:\n` +
        `  credential: ${credential.slice(0, 12)}…\n` +
        `  found in:   ${[...new Set(found)].map((s) => JSON.stringify(s.slice(0, 200))).join('\n              ')}\n\n` +
        'Every string this package builds out of a service response, a header, a platform ' +
        'error or a caller-supplied value goes through `createRedactor` first. A value ' +
        'reaching a thrown object without passing it is a bug in a message-building ' +
        'expression, not in the redactor.',
    );
  }

  // The serialised forms, spelled out separately so that a failure says which one.
  for (const [form, text] of [
    ['String()', String(value)],
    ['JSON.stringify()', safeStringify(value)],
    ['value.stack', typeof value?.stack === 'string' ? value.stack : ''],
    ['value.message', typeof value?.message === 'string' ? value.message : ''],
  ]) {
    assert.ok(
      !text.includes(credential),
      `the credential reached ${form} of the ${where}:\n${text.slice(0, 400)}`,
    );
  }
```

`captureOutput` replaces `console.log/info/warn/error/debug/trace/dir/table`,
`process.stdout.write` and `process.stderr.write` for the duration of the call
and restores them in a `finally`.
### And the static half, which is the rest of the file

`describe('the source contains no logging and no telemetry')` strips comments
from the six `src/cafaye/*.ts` files (this repository's files are mostly
comments and several of them *discuss* logging, so a scan that matched its own
documentation is a scan that gets disabled — `suite-is-offline.test.mjs` records
that happening twice already) and then fails on any `console.`,
`process.stdout`/`stderr`, `navigator.sendBeacon`, `process.emitWarning`,
`trace.*`, or file write; on any write to or delete from `process.env`; and on a
non-empty `dependencies`.

### Two real leaks it found

1. **`cause`.** Node's `util.inspect` walks the cause chain and so does every
   crash reporter, so preserving undici's error verbatim is a leak if anything in
   it is credential-shaped. `safeCause` now withholds the original **entirely**
   when the redactor says there is something to withhold, keeping `name` and
   `code` because those are enums. The errno is *also* recorded on the error
   itself, so withholding a cause never costs the caller the one thing they
   needed — and the paired test proves a clean cause is still kept untouched.
2. **The caller's abort reason.** `AbortSignal.any` adopts the reason from
   whichever side fired, so a caller who aborts with an error of their own
   produced a rejection indistinguishable from a network failure (`reason` came
   back `'unknown'`). Fixed in the class, not in the test; see §6.

---

## 4. The base-URL precedence order I chose

Resolved **once, in the constructor, for all six services**. Highest first:

| # | Source | Notes |
|---|---|---|
| 1 | `baseUrl` as a record — the entry for that service | beats the string, because a caller who wrote six URLs meant them |
| 2 | `baseUrl` as a string | applies to all six |
| 3 | `CAFAYE_<SERVICE>_BASE_URL` | name **derived** by `baseUrlEnvFor`, not written out six times |
| 4 | `CAFAYE_BASE_URL` | one origin for all six |
| 5 | `globalThis.location.origin` | the host's own origin; the weakest statement of intent, and genuinely right only for a browser served from the same origin as the fleet |
| 6 | **throws** `CafayeConfigurationError` | naming every source consulted, suggesting no host |

Rules attached to it, each with a test:

- **No default and no loopback fallback.** The generated clients each carry a
  documented default pointing at the public SaaS, and a loopback default is that
  same failure in friendlier clothes. A test asserts the thrown message contains
  no `localhost`, no `127.0.0.1`, no `::1` and no `0.0.0.0`.
- **An empty or whitespace-only env var counts as unset**, not as a base URL. An
  empty base URL concatenated with a path produces a relative path, which is the
  same silent default one indirection further out.
- **A non-absolute-`http(s)` value is refused** — `identity.example.com` is not a
  base URL, because the generated transport concatenates rather than resolving.
  `file://` and `chrome-extension://` host origins are refused for the same
  reason.
- **Trailing slashes are stripped**, so `cafaye.baseUrls.x` is the URL that goes
  on the wire. A path prefix is kept, because a self-hoster may serve the fleet
  under `/cafaye`.
- **A partial record fails at construction**, naming the service. This is the one
  consequence of "resolved once, for all six" that is worth stating explicitly: it
  is stricter than lazily resolving per service, and it is deliberate — a
  misconfiguration reported at construction is a misconfiguration reported before
  any request exists.

---

## 5. The error hierarchy and the fallback rule

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

**The fallback rule, in the brief's own terms:** `CafayeProblemError` is
instantiable and is what an unrecognised problem `code` produces. A service that
adds a code tomorrow yields a `CafayeProblemError` carrying that code, its
`type`, its `status`, its `trace_id` and its extension members — **not** a bare
`Error`. A caller can therefore always write

```js
if (!isCafayeError(e)) throw e;   // kind, status, code, traceId — on every failure
```

and have it work against every failure this class can produce, including the ones
nobody has seen. Asserted three ways: a code from core's reserved list that has
no class of its own (`internal`, `unavailable`), a code that is not in the
reserved list at all (`account_locked`, 423), and a problem with no `code` and no
recognised status (500).

**`code` chooses the class; `status` breaks the tie.** core's conventions call
`type` the machine-readable contract, and RFC 9457 makes `status` advisory — so a
403 carrying `code: "forbidden"` is a `CafayeForbiddenError` even if the number
drifts, the reported `status` is still whatever the service actually sent, and a
problem with no `code` at all still maps from the number.

**Every RFC 9457 member plus cafaye's two is a first-class field** — `type`,
`title`, `status`, `detail`, `instance`, `code`, `traceId`, `errors` — and
**everything else lands in `extensions`**, redacted, recursively. Known members
are not duplicated into `extensions`, and there is a test for that, because a
client that kept only the known set would silently drop a field a service added
yesterday.

**`isCafayeError` also recognises a second copy of this package**, via a
`Symbol.for` brand defined non-enumerable. Two versions in one dependency tree
give two constructors, `instanceof` returns false across the boundary, and the
resulting failure looks like a bug in the consumer's error handling. The brand is
non-enumerable so it does not appear in `JSON.stringify(err)`, and there is a test
for that too.

---

## 6. Every judgment call this brief left open

**Three credential shapes, not two.** The brief says "two auth models"; identity-08
added a third *shape* (an opaque scoped API token) on top of the two models. I
classified three ways, and the JWT case is separated from the session case on
purpose: a session is the only shape core allows in a `Cookie` header, so a JWT
misread as a session would publish a fleet-wide credential onto the browser
surface, which a script cannot set and a proxy will log. The asymmetry decides
the fallback — a session misread as a JWT loses a cookie the bearer header
already covers; a JWT misread as a session does not.

**Both forms for a session, and the reason.** The brief asks for a session cookie
"sent as a cookie". It goes out as `Cookie: __Host-session=…` **and** as
`Authorization: Bearer …`, because identity's document states the resolution when
both are present ("An `Authorization: Bearer` header is preferred over the cookie
when both are present, because a client holding both has said which one it
means"), so sending both is unambiguous by the server's own rule — and it is what
lets one credential work against identity and against the other five with no
choice at the call site. The tie-break is the server's, not mine.

**`cafaye_` is identity's discriminator and this package reads it.** I did not
invent a discriminator. `internal/httpapi/apikeys.go` names the prefix and gives
the reason — the api_keys and sessions tables are different tables, and the
prefix decides which is consulted without a query. Following identity rather than
inventing is the decision.

**The credential attaches to every request, unconditionally.** The obvious
refinement — attach only where the document declares a security scheme — is
measurably wrong for this fleet. `grep` over the six vendored documents finds
per-operation `security` arrays on eleven identity operations and six courier
ones, and **none** on billing, muse, darkroom or pantry: muse and darkroom state
theirs *globally*, which the generator does not copy onto each operation, and
billing and pantry state `security: []` with a note. A client that respected the
arrays would send unauthenticated requests to four of six services, and the
failure would be a 401 from a service rather than an error from the client. The
measurement is written into the test that depends on it.

**Six base-URL sources, and the throw is the sixth.** Documented in §4, with a
test per step plus a three-way ladder assertion and the loopback-absence
assertion.

**A non-problem non-2xx is a `CafayeProtocolError`, with a redacted body excerpt.**
A proxy's HTML 502 is a failure, but not a *problem*, and giving it a cafaye
`code` would be inventing one. The excerpt is kept because a proxy 502 is
undiagnosable without it — and dropped *entirely* when redaction removed
anything, because a partly-scrubbed excerpt is a scrubber whose recogniser had a
gap.

**A 200 carrying a problem document throws.** The brief asked me to decide. It
throws, because the alternative is handing the caller a `Problem` where its types
promised a `User` — a `TypeError` three frames from the mistake instead of a
diagnosis at it. The check is the content type *or* the body shape; nothing in the
six documents' success schemas has `type`, `title` and `status` together, so the
structural half has no false positive against the current fleet, and there is a
test that `identity`'s real `/healthz` `{status: 'ok'}` still works.

**One type covers HTTP and network failures, with the distinction queryable.**
The brief offered "one type, distinction queryable" or "two types and a stated
rule". I took the first *and* kept subclassability, which is strictly more: one
base class with `kind` and a `status` that is `null` when there was no response,
so the common handler is `e.status !== null` rather than an `instanceof` ladder,
while `e instanceof CafayeNetworkError` still works for a caller who cares.
`kind: 'protocol'` and `kind: 'configuration'` are the other two answers, so all
four failure modes are one `catch`.

**A timeout is not a DNS failure, and neither collapses into "network".**
`CafayeTimeoutError extends CafayeNetworkError`, and `reason` is
`'timeout' | 'aborted' | 'dns' | 'connection' | 'tls' | 'unknown'`. `aborted` is
separate from `timeout` because only one of them is a failure of anything —
`aborted` is the caller's own signal, which a wrapper that does not know whose
signal it was must not retry. `tls` is separate because retrying a bad certificate
is how an outage becomes an incident. `unknown` is an answer, not a shrug: it
means the class could not tell, which happens with a custom `fetch` and with
`timeoutMs: 0` plus a custom abort reason. Both limitations are documented in
`errors.ts` and asserted.

**A default timeout of 30 seconds, `0` to disable.** Not asked for. A client with
no timeout hands the caller an unresolved promise instead of a 200; 30s is longer
than any of the 53 operations needs and short enough that a wedged service is
reported rather than inherited.

**`setCredentials` exists.** Not asked for. The attachment is per request, so
rotation is three lines; a long-lived process that outlives a token is a normal
thing, and a client that cannot be given a new credential has to be thrown away.
`credentialKind` is exposed so a caller can see which kind it handed over; the
**value is not**, deliberately.

**`rawClient(service)` is a deliberate escape hatch.** MD6 notes that courier's
document is partial and that a generated client will not know about a route the
router serves. Without an escape hatch, a consumer literally cannot call such a
route. It is named so its cost is visible — **errors from it are the generated
envelope, not typed exceptions** — and that is stated in the README, the JSDoc and
the property name.

**The six service names are stated three times, and a test keeps them honest.** A
static import is a static import, and a consumer's editor needs real properties to
complete. `test/wrapper-class.test.mjs` asserts that `services.ts`'s record, the
class's own properties and the six services in `specs/index.json` are the same
six — the same tripwire shape as `regeneration.test.mjs` and as courier's
document path. A seventh service fails in the place where the omission is, rather
than producing a six-of-seven client that reports success.

**Wrapper tests import `dist/`, and `test/lib/dist.mjs` builds on demand.**
`src/` is TypeScript and is not what a consumer installs. Building on demand
removes a real fragility: `readme-examples.test.mjs` already assumed
`package-contents.test.mjs` had built `dist/` first, which is a fact about
alphabetical file order.

**Two dead spots I chose to close rather than document.** A per-call `baseUrl` and
a per-call `auth` are omitted from the bound operation's *type*, so a TypeScript
caller cannot pass them — but a JavaScript one can, and a per-call `baseUrl` would
send one request somewhere the other five are not going. Both are now removed from
whatever arrives rather than merely overridden, and there is a runtime test,
because the type is not the only door.

**One decision that was *not* mine.** `Cafaye`'s per-request signal composition
uses its own `AbortController` rather than `AbortSignal.any`, because `any` adopts
the reason from whichever side fired and a caller who aborts with an error of
their own produced an unclassifiable rejection. That is recorded in
`AGENTS.md` with the failure behind it, because the next person to reach for
`AbortSignal.any` will reach for it for good reasons.

---

## 7. What I deliberately did not build

- **Nothing that composes two services.** No register-then-create-account, no
  pagination helper, no token refresh, no retry, no cache. Each is a place to put a
  policy the platform should own, and putting one in the client makes the fleet's
  current shape a thing a consumer's application depends on. MD6 named four
  responsibilities and this class has those four.
- **No runtime validation of service responses.** The generated types come from
  the documents; a service that drifts produces a wrong value shaped like a right
  one. Catching that needs a runtime schema library and a dependency tree, which
  MD6 rules out and `no-runtime-dependencies.test.mjs` enforces.
- **No telemetry, and no logging of any kind.** The brief: "This package does not
  emit telemetry, and if you find yourself adding any, stop." The `fetch` option is
  the seam for anyone who wants traces.
- **No re-vendoring of `identity`.** Its document is behind on purpose: the
  vendored copy is at `35c2576` and the scoped API token routes landed in
  `bff6333`, so this client has no typed `createApiKey` even though it reads the
  credential shape identity mints. `specs/index.json`'s provenance is not this
  packet's, and the brief forbade touching it. **This is the most consequential
  thing left undone** and it is recorded in `AGENTS.md` under "What a green run
  does not prove" with both shas.
- **No `User-Agent`, no retry policy, no request id generation, no cursor
  pagination.** All four are policies a consumer or the platform should own.
- **No MD7 resolution.** The client forwards the credential without parsing it, so
  the `scope`/`scopes` ambiguity is invisible here — which is the correct outcome
  and is written down as such, because "invisible" can also mean "unnoticed".
- **The npm package name and the `core: ^0.2.0` range are left open**, as the brief
  and `cafaye.yml` both require. `cafaye.yml` is unmodified.
- **No remote, no push, no visibility change, no publish, no `moon/refs/`.**
  Everything is on `worker/cafaye-ts-02` in the worktree.

---

## 8. Four defects the tests found in my own work, and one in the harness

Recorded because they are the argument for writing the tests the way I did.

1. **A response interceptor that returned `undefined`.** The generated transport
   assigns a response hook's result back over the response
   (`response = await fn(response, request, opts)`), so my cleanup hook silently
   replaced every good response with nothing and every request in the suite failed
   as `the request failed: [object Object]`.
2. **`AbortSignal.timeout` is untestable.** It uses an internal timer that
   `node:test`'s mock timers cannot reach, so a pending deadline let the event loop
   drain and the test runner reported "Promise resolution is still pending but the
   event loop has already resolved". Found by writing the test and watching it.
   Fixed by owning a `setTimeout` — which is also unref'd, so it does not hold a
   process open.
3. **`AbortSignal.any` loses the abort reason's origin**, which turned a caller's
   custom abort into `reason: 'unknown'`. Found by the credential-leak test.
4. **`BoundOperation` was wrong three times** and no runtime test could see any of
   them: a missing `Promise` unwrap, an optionality test that
   `noUncheckedIndexedAccess` made silently wrong, and `muse`'s `role` union
   arriving as `string`. Found by compiling a probe through the package name.
5. **`readme-examples.test.mjs` had three defects of its own**, all surfaced by
   giving it a README with more in it: it could not parse a multi-line import (it
   hoisted one line and left the rest as bare identifiers, producing four
   "Identifier expected" errors that named nothing); it skipped every capitalised
   name as a type, so it skipped exactly `Cafaye`; and it deduplicated hoisted
   imports by text, so two examples that each say `import { Cafaye }` — as they
   must, if a reader can start at either — collided with `TS2300`. All three fixed
   in place, with the reasoning recorded beside them.

---

## 9. If I were doing this again

- **`_bind` is a `Object.entries` map with a wrapper per function.** It works, and
  the mapped type keeps the generated names visible to an editor (a `Proxy` would
  not), but it is 53 wrappers built at construction. A lazily-memoised version
  would cost less and lose the "a plain frozen object" property, which is worth
  more than the microseconds.
- **`rawClient` deserves a typed variant.** It exists precisely for the route the
  documents have not caught up with, and it is the one surface where errors are not
  typed. A `request(service, {method, url, …})` that reuses `#unwrap` would close
  that gap in about fifteen lines, and I left it out because it is a public API
  decision rather than an implementation one.
- **The six base-URL sources are six branches of one function**, and the
  `explicit` string-vs-record branch duplicates the two env candidates. It reads
  clearly today; it is the part of `base-url.ts` I would expect to need touching
  if the fleet ever grew a seventh deployment shape.
- **`classifyNetworkFailure` is a growing table.** Six reasons now, each with a
  comment naming the code it covers. The day a runtime adds a code, the honest
  `unknown` means someone finds out from a support ticket rather than from a
  failing test.
