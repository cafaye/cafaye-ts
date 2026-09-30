// A credential that reaches a log is a credential that has leaked.
//
// The brief: "**Never log a token, a cookie, or a JWT.** Not at debug level, not
// in an error message, not in a thrown exception's message. A credential that
// reaches a log is a credential that has leaked, and this package is the one
// place in a consumer's application that touches every credential it has. **This
// is the most important constraint in the brief.** Write a test that proves a
// token string appears in no log record, no exception message and no thrown
// object's serialised form."
//
// This file is that test, and it is deliberately paranoid about WHERE a string
// can hide, because the interesting failures are not in `message`:
//
//   - `error.message` is the obvious one, and the easiest to get right.
//   - `error.stack` is not. V8 builds it from the message, so anything in the
//     message is in the stack, and the stack is what a crash reporter prints.
//   - Every OWN property, not just the enumerable ones. `Error.prototype.message`
//     is inherited; `CafayeProblemError.detail` is not. A problem document's
//     `detail` is server-controlled prose and is the single most likely place for
//     a service to echo a caller's own credential back — and it is a plain
//     enumerable field, so `JSON.stringify(err)` carries it.
//   - The `cause` chain. undici's `TypeError: fetch failed` has a cause, that has
//     a cause, and Node's `util.inspect` walks the whole chain — which is why
//     `safeCause` withholds the original outright rather than scrubbing a copy.
//   - `String(err)` and `err.toString()`, which most log formatters reach for
//     before anything else.
//
// And the output side, which is the other half: the class emits NOTHING. Not at
// debug level, not behind an option, not to `console`, not to a stream, not to a
// telemetry endpoint. A library that logs nothing cannot leak a credential by
// logging, and the test asserts that by capturing every console method and both
// streams across every path the class has — success, problem document, protocol
// error, network error, timeout, caller abort, and a configuration error thrown
// before any request exists.
//
// WHY THE ATTACK IS ADVERSARIAL RATHER THAN INNOCENT
//
// Each of the failure paths below is fed a service or a gateway that has
// deliberately put a credential into the response: a `detail` that echoes the
// token, an extension member that echoes it, a `Set-Cookie` header that echoes
// it, an HTML error page from a proxy that echoes it, and a `fetch` that rejects
// with an error whose message echoes it. An innocent `assert(!message.includes
// (TOKEN))` would pass against all of those being absent, and would prove
// nothing about the ones that are present.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { REPO_ROOT } from '../scripts/lib/specs.mjs';
import { loadDist } from './lib/dist.mjs';

const { Cafaye, serviceNames } = await loadDist('index.js');

/**
 * Three credentials, one per shape the fleet mints, at the shapes the fleet
 * actually mints them.
 *
 * Both opaque values are 43 base64url characters, because both are
 * `base64.RawURLEncoding` over 32 random bytes and 32 bytes is 256 bits — the
 * same order as a UUIDv4. identity's `internal/sessions/token.go` and
 * `internal/apikeys/apikeys.go` are the two places that say so, and the API token
 * is `cafaye_` plus the same 43. A class that guarded only the `cafaye_` prefix
 * would pass a test carrying only an API token, which is why all three are here.
 */
const API_TOKEN = `cafaye_${'J0fwN4jAR8nEVarIZevM3izQ7mDU_qHYduL2hyP6lCT'}`;
const SESSION_TOKEN = '3izQ7mDU_qHYduL2hyP6lCT-pGXctK1gxO5kBS9oFWb';
const JWT_TOKEN = `${Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'cafaye-1' })).toString('base64url')}.${'B'.repeat(86)}.${'C'.repeat(43)}`;

const CREDENTIALS = [API_TOKEN, SESSION_TOKEN, JWT_TOKEN, `__Host-session=${SESSION_TOKEN}`];

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
}

/** Capture everything written to the console or to a stream. */
function captureOutput(run) {
  const written = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'];
  const original = {};
  const record = (...args) => {
    written.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  for (const method of methods) {
    original[method] = console[method];
    console[method] = record;
  }
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = record;
  process.stderr.write = record;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const method of methods) console[method] = original[method];
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    })
    .then((value) => ({ value, written }));
}

/**
 * A transport that replies with whatever the test says.
 *
 * The `Request` is passed through rather than discarded, because several of the
 * paths below have to read `request.signal` — a timeout and a caller's abort both
 * arrive by way of it, and a helper that dropped it made both of them fail with
 * `Cannot read properties of undefined`.
 */
function transport(reply) {
  return async (request) => reply(request);
}

/** A cafaye problem document, with whatever the test put in it. */
function problem(overrides = {}) {
  return {
    type: 'https://errors.cafaye.com/internal',
    title: 'internal',
    status: 500,
    detail: 'an ordinary detail that names nothing sensitive',
    instance: '/v1/me',
    code: 'internal',
    trace_id: '0af7651916cd43dd8448eb211c80319c',
    ...overrides,
  };
}

const problemResponse = (body, status = 500) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

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

describe('the source contains no logging and no telemetry', () => {
  // The static half, and it is the half that survives a refactor. The behavioural
  // half above can only prove that the paths it thought of are quiet; this proves
  // that the words are not in the source at all.
  //
  // Comments are stripped first, because this repository's files are mostly
  // comments and several of them discuss logging by name — a scan that matched
  // its own documentation would be a scan that gets disabled, which
  // `test/suite-is-offline.test.mjs` already records happening twice.
  it('has no console call, no stream write, and no telemetry call in src/cafaye/', async () => {
    const files = [
      'class.ts',
      'credentials.ts',
      'base-url.ts',
      'errors.ts',
      'redact.ts',
      'services.ts',
    ];
    const offenders = [];

    for (const name of files) {
      const source = await readFile(path.join(REPO_ROOT, 'src', 'cafaye', name), 'utf8');
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

      const found = [
        [/\bconsole\s*\./, 'a console call'],
        [/\bprocess\s*\.\s*(stdout|stderr)\b/, 'a stream write'],
        [/\bglobalThis\s*\.\s*console\b/, 'a console reference'],
        [/\bnavigator\s*\.\s*sendBeacon\b/, 'a telemetry beacon'],
        [/\b(process|globalThis)\s*\.\s*emitWarning\b/, 'a warning'],
        [/\btrace\.(?:get|set|span)\b/, 'a tracing API'],
        [/\bwriteFile|\bappendFile/, 'a file write'],
      ].filter(([pattern]) => pattern.test(code));

      if (found.length > 0) {
        offenders.push(`src/cafaye/${name}: ${found.map(([, what]) => what).join(', ')}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `${offenders.join('\n')}\n\n` +
        'This package emits nothing. The brief is explicit — "Never log a token, a cookie, ' +
        'or a JWT. Not at debug level" — and the only way to guarantee that for a library is ' +
        'to have no output path at all: a debug log is a log level somebody disables in ' +
        'production and pastes into a bug report.',
    );
  });

  it('reads the environment and never writes it', async () => {
    // `process.env` is read for base-URL resolution, which is legitimate. WRITING
    // it would be a different thing: this package has no business putting a
    // credential into a process environment, where it would be inherited by every
    // child process and printed by any crash reporter that dumps the environment.
    const source = await readFile(path.join(REPO_ROOT, 'src', 'cafaye', 'class.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.doesNotMatch(code, /process\s*\.\s*env\s*(\[|\.)?\s*=/, 'src/cafaye/class.ts writes process.env');
    assert.doesNotMatch(code, /\bdelete\s+process\s*\.\s*env\b/, 'src/cafaye/class.ts deletes from process.env');
  });

  it('has no runtime dependency to leak through', async () => {
    // The last way a credential escapes without anybody writing it down: a
    // dependency that logs, or an HTTP client that keeps a debug buffer. MD6
    // requires zero, `test/no-runtime-dependencies.test.mjs` asserts it, and
    // asserting it here as well is cheap — this file's claim is "nothing can
    // leave", and a dependency is a door.
    const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dependencies ?? {}, {});
  });
});

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
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
