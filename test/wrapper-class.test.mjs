// The class, on the wire, through an injected transport.
//
// The unit tests in this directory check the pieces: the discriminator, the
// precedence, the mapping. This one checks that they are WIRED to each other —
// that the credential is on the header the generated transport builds, that the
// timeout is the signal the transport aborts on, and that a problem document
// coming back through the real generated code becomes a typed exception rather
// than an envelope.
//
// WHY AN INJECTED TRANSPORT AND NOT A SERVER
//
// No socket, no port, no listening, no cleanup, and no `127.0.0.1`. The `fetch`
// option is a real part of the API (a consumer supplies an instrumented client
// through it), so a fake one is not a test-only seam dressed up as a feature —
// and the generated transport takes `opts.fetch ?? _config.fetch ??
// globalThis.fetch`, so a transport passed at construction is the one every
// request uses. The fake records the `Request` it was handed and returns a
// `Response` the test built, which means every assertion below is about bytes
// that would have gone out.
//
// WHY NO TIMERS AND NO WAITS
//
// The brief's rule: "No sleeps. No raised retries. No loosened assertions. Use a
// fake clock and an injected transport, not a wait." The timeout cases are the
// interesting ones and they are handled two ways rather than one. The CLASSIFICATION
// of a timeout is a pure function and is tested as one, in
// `test/wrapper-errors.test.mjs`, against the error shapes Node 22 produces. The
// WIRING — that this class installs a deadline and that firing it produces a
// `CafayeTimeoutError` — is tested with a one-millisecond deadline and a
// transport that settles when the signal it was given aborts. That is not a
// sleep: the test awaits an event the code under test schedules, it has no
// timeout of its own to race, and it cannot fail by being slow. There is no
// `setTimeout` in any of these tests that exists to make an assertion true.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { readIndex } from '../scripts/lib/specs.mjs';
import { loadDist } from './lib/dist.mjs';

const {
  Cafaye,
  CafayeConfigurationError,
  CafayeError,
  CafayeNetworkError,
  CafayeProblemError,
  CafayeProtocolError,
  CafayeTimeoutError,
  CafayeUnauthenticatedError,
  CafayeValidationError,
  isCafayeError,
  serviceNames,
  identity: identityNamespace,
  billing: billingNamespace,
  courier: courierNamespace,
  darkroom: darkroomNamespace,
  muse: museNamespace,
  pantry: pantryNamespace,
} = await loadDist('index.js');

// The service list, read once the way every other test file in this repository
// reads it. `readIndex` is async, and this file already has a top-level await
// for the package itself.
const index = await readIndex();

const API_TOKEN = `cafaye_${'A'.repeat(43)}`;
const SESSION_TOKEN = 'B'.repeat(43);
const b64url = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
const A_JWT = `${b64url({ alg: 'RS256', kid: 'k1' })}.${'C'.repeat(86)}.${'D'.repeat(43)}`;

/**
 * A `fetch` that records every request and replies with whatever the test says.
 *
 * A closure over a mutable `reply` rather than an argument, because the generated
 * transport hands its fetch implementation a single `Request` and a test wants to
 * change the answer between calls without rebuilding the client.
 */
function recordingTransport() {
  const requests = [];
  const transport = async (request) => {
    requests.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      request,
    });
    return current(request);
  };
  let current = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  transport.requests = requests;
  transport.respondWith = (fn) => {
    current = fn;
  };
  /**
   * Reply with a body. An object is JSON with `application/json` unless the
   * caller says otherwise, because defaulting every reply to
   * `application/problem+json` would make every success in this file trip the
   * 2xx-carries-a-problem rule — which is a correct rule and would be testing
   * itself here instead of what it is for.
   */
  transport.reply = (body, init = {}) =>
    transport.respondWith(() =>
      typeof body === 'string'
        ? new Response(body, init)
        : body === null || body === undefined
          ? // A 204 with a body is refused by the platform's own Response
            // constructor, and a 204 is one of the fleet's documented responses
            // (`DELETE /v1/session`), so the no-body case has to be expressible.
            new Response(null, init)
          : new Response(JSON.stringify(body), {
              ...init,
              headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
            }),
    );
  return transport;
}

/**
 * A transport that never answers, and rejects with the signal's reason when the
 * request is aborted — which is what the platform's own `fetch` does, including
 * for a signal that was ALREADY aborted when the transport was reached.
 */
function abortingTransport(request) {
  return new Promise((_, reject) => {
    if (request.signal.aborted) {
      reject(request.signal.reason);
      return;
    }
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  });
}

/**
 * Let every pending microtask settle.
 *
 * `setImmediate` is a macrotask boundary, not a timer: nothing is scheduled for
 * later and nothing can be early or late. It is here because the call chain from
 * a bound operation to the injected transport contains several `await`s — the
 * generated transport's `beforeRequest` awaits the credential validator, and the
 * validator is `async` — and a test that checks what the transport was handed has
 * to get past them without a delay.
 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A cafaye problem document, as a service sends one. */function problem({ code, status, ...rest } = {}) {
  return {
    type: `https://errors.cafaye.com/${code ?? 'internal'}`,
    title: (code ?? 'internal').replace(/_/g, ' '),
    status: status ?? 500,
    detail: 'the specific thing that happened once',
    instance: '/v1/me',
    code,
    trace_id: '0af7651916cd43dd8448eb211c80319c',
    ...rest,
  };
}

function client(options = {}) {
  const fetchImpl = options.fetch ?? recordingTransport();
  const cafaye = new Cafaye({ baseUrl: 'https://cafaye.example.com', fetch: fetchImpl, ...options });
  return { cafaye, fetchImpl };
}

const ENV_NAMES = [
  'CAFAYE_BASE_URL',
  ...['identity', 'billing', 'muse', 'darkroom', 'pantry', 'courier'].map(
    (s) => `CAFAYE_${s.toUpperCase()}_BASE_URL`,
  ),
];
const savedEnv = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  delete globalThis.location;
});

describe('the six service namespaces', () => {
  it('are the six services, and they are the six in specs/index.json', () => {
    // THE test for the three-lists problem. The six names appear in three places
    // in the source because a static import is a static import and a consumer's
    // editor needs real properties to complete: in `services.ts` (the imports and
    // the record), in `class.ts` (six typed properties) and in
    // `openapi-ts.config.ts` (which derives from the index). This is the
    // assertion that keeps the three honest — a seventh service added to the
    // fleet fails HERE, in the place where the omission is, rather than
    // producing a six-of-seven client that reports success. That is the same
    // tripwire shape as `regeneration.test.mjs` and as courier's document path
    // in `vendored-specs.test.mjs`.
    assert.deepEqual([...serviceNames].sort(), index.services.map((s) => s.service).sort());
    const { cafaye } = client();
    const properties = Object.keys(cafaye).filter((k) =>
      ['identity', 'billing', 'courier', 'darkroom', 'muse', 'pantry'].includes(k),
    );
    assert.deepEqual(properties.sort(), [...serviceNames].sort());
  });

  it('expose the generated operations, bound and callable', async () => {
    const { cafaye, fetchImpl } = client({ credentials: { token: SESSION_TOKEN } });
    fetchImpl.reply({ id: 'usr_1', email: 'a@example.com', created_at: '2026-09-30T00:00:00Z' });

    const user = await cafaye.identity.getCurrentUser();
    // The data, not the envelope. If this were the envelope, `user.id` would be
    // undefined and `user.data.id` would be the id — and the type probe in
    // test/wrapper-types.test.mjs is what makes that a compile error as well.
    assert.equal(user.id, 'usr_1');
    assert.equal(user.email, 'a@example.com');
    assert.equal(fetchImpl.requests.length, 1);
    assert.equal(fetchImpl.requests[0].url, 'https://cafaye.example.com/v1/me');
  });

  it('expose the very same operation functions the generated namespace does', async () => {
    // "Generated, and it is the same generated code" is a claim worth asserting
    // rather than describing: a wrapper that reimplemented an operation would
    // answer this with a different function and quietly stop being MD6's
    // "generated types and per-service transport, wrapped by one hand-written
    // client".
    const { cafaye } = client();
    for (const [name, namespace] of Object.entries({
      identity: identityNamespace,
      billing: billingNamespace,
      courier: courierNamespace,
      darkroom: darkroomNamespace,
      muse: museNamespace,
      pantry: pantryNamespace,
    })) {
      const bound = cafaye[name];
      const generated = Object.keys(namespace).filter((k) => typeof namespace[k] === 'function');
      assert.ok(generated.length > 0, `${name} exposes no operations`);
      assert.deepEqual(
        Object.keys(bound).sort(),
        generated.sort(),
        `${name} is missing operations the generated namespace has`,
      );
    }
  });

  it('sends every service to the base URL it was resolved for', async () => {
    // A per-service record, which is what a self-hoster with six hosts writes,
    // and the class has to resolve all six at construction rather than lazily —
    // so a fifth entry that was missing is a constructor error, not a surprise on
    // the fifth call.
    const fetchImpl = recordingTransport();
    const bases = {
      identity: 'https://identity.example.com',
      billing: 'https://billing.example.com',
      courier: 'https://courier.example.com',
      darkroom: 'https://darkroom.example.com',
      muse: 'https://muse.example.com',
      pantry: 'https://pantry.example.com',
    };
    const cafaye = new Cafaye({ baseUrl: bases, fetch: fetchImpl });
    assert.deepEqual({ ...cafaye.baseUrls }, bases);

    fetchImpl.reply({ id: 'x' });
    await cafaye.identity.getCurrentUser();
    await cafaye.billing.getCustomer({ path: { id: 'cus_1' } });
    await cafaye.muse.routeCompletion({ body: { model: 'fast', messages: [] } });
    await cafaye.pantry.getService({ path: { name: 'pantry' } });

    assert.deepEqual(
      fetchImpl.requests.map((r) => r.url),
      [
        'https://identity.example.com/v1/me',
        'https://billing.example.com/v1/customers/cus_1',
        'https://muse.example.com/v1/route',
        'https://pantry.example.com/v1/services/pantry',
      ],
    );
  });

  it('refuses to construct when one service of six has nowhere to go', async () => {
    // The consequence of resolving all six eagerly and of having no default: a
    // partial `baseUrl` record is a deployment mistake, and it is reported at
    // construction rather than on the fifth call, with the name of the missing
    // service in the message.
    for (const name of ENV_NAMES) delete process.env[name];
    assert.throws(
      () =>
        new Cafaye({
          baseUrl: { identity: 'https://identity.example.com', courier: 'https://courier.example.com' },
        }),
      (error) => {
        assert.ok(error instanceof CafayeConfigurationError);
        assert.match(error.message, /billing/);
        return true;
      },
    );
  });

  it('hands back each service\'s own generated client from rawClient', () => {
    // MD6 names the gap this exists for: courier's document is partial by its own
    // header, so `/v1/notification_preferences/:user_id` is not in the generated
    // client even though courier serves it.
    const { cafaye } = client();
    const raw = cafaye.rawClient('courier');
    assert.equal(typeof raw.get, 'function');
    assert.equal(typeof raw.request, 'function');
    assert.equal(raw.getConfig().baseUrl, 'https://cafaye.example.com');
    // And it is a different function from the bound one, so a caller can tell
    // which surface they are on.
    assert.notEqual(raw.get, cafaye.courier.listWebhookEndpoints);
  });
});

describe('credentials on the wire', () => {
  it('sends a scoped API token as a bearer header and nothing else', async () => {
    // identity's `apikeys.go` calls the prefix the discriminator, and an API key
    // is identity's own surface. A cookie would be a browser credential carrying
    // a machine credential, which is the wrong surface for it.
    const { cafaye, fetchImpl } = client({ credentials: { token: API_TOKEN } });
    fetchImpl.reply({ id: 'usr_1' });
    await cafaye.identity.getCurrentUser();

    assert.equal(fetchImpl.requests[0].headers.authorization, `Bearer ${API_TOKEN}`);
    assert.equal(fetchImpl.requests[0].headers.cookie, undefined, 'an api token went out in a cookie');
  });

  it('sends a session token as a bearer header AND as the __Host-session cookie', async () => {
    // Both, not one. identity's document states the resolution when both are
    // present — "An `Authorization: Bearer` header is preferred over the cookie
    // when both are present, because a client holding both has said which one it
    // means" — so sending both is unambiguous by the server's own rule, and it is
    // what lets one credential work against identity (which takes the cookie) and
    // against the other five (which core says take a bearer and nothing else) with
    // no choice at the call site.
    const { cafaye, fetchImpl } = client({ credentials: { token: SESSION_TOKEN } });
    fetchImpl.reply({ id: 'usr_1' });
    await cafaye.identity.getCurrentUser();

    assert.equal(fetchImpl.requests[0].headers.authorization, `Bearer ${SESSION_TOKEN}`);
    assert.equal(fetchImpl.requests[0].headers.cookie, `__Host-session=${SESSION_TOKEN}`);
  });

  it('sends a JWT as a bearer header and NOT as a cookie', async () => {
    // The asymmetry that decides the three-way classification. A session is the
    // only shape core allows in a cookie ("No cookies for API traffic; browser
    // sessions use … cookies and a CSRF token, and those are a *different*
    // surface"). A JWT misread as a session would publish a fleet-wide service
    // credential onto the browser surface, which a script cannot set and a proxy
    // will log.
    const { cafaye, fetchImpl } = client({ credentials: { token: A_JWT } });
    fetchImpl.reply({ id: 'usr_1' });
    await cafaye.identity.getCurrentUser();

    assert.equal(fetchImpl.requests[0].headers.authorization, `Bearer ${A_JWT}`);
    assert.equal(fetchImpl.requests[0].headers.cookie, undefined, 'a JWT went out in a cookie');
  });

  it('attaches the credential to an operation that declares no security', async () => {
    // Measured, not assumed. `grep` over the six vendored documents finds
    // per-operation `security` arrays on eleven identity operations and six
    // courier ones, and NONE on billing, muse, darkroom or pantry — muse and
    // darkroom state theirs globally, which the generator does not copy onto each
    // operation. A client that respected the arrays would silently send
    // unauthenticated requests to four of six services, and the failure would be
    // a 401 from a service rather than an error from the client.
    const { cafaye, fetchImpl } = client({ credentials: { token: API_TOKEN } });
    fetchImpl.reply({ id: 'in_1' });
    await cafaye.billing.getCustomer({ path: { id: 'cus_1' } });

    assert.equal(fetchImpl.requests[0].headers.authorization, `Bearer ${API_TOKEN}`);
  });

  it('sends no credential at all when it holds none', async () => {
    // The unauthenticated client is a real one: registering and signing in both
    // happen before there is anything to send.
    const { cafaye, fetchImpl } = client();
    fetchImpl.reply({ id: 'usr_1' });
    await cafaye.identity.getCurrentUser();

    assert.equal(fetchImpl.requests[0].headers.authorization, undefined);
    assert.equal(fetchImpl.requests[0].headers.cookie, undefined);
    assert.equal(cafaye.credentialKind, null);
  });

  it('lets a caller override the credential per call, rather than clobbering theirs', async () => {
    // The generated client applies the same rule to the same problem
    // (`checkForExistence` in its utils), and matching it means two rules rather
    // than two surprises.
    const { cafaye, fetchImpl } = client({ credentials: { token: API_TOKEN } });
    fetchImpl.reply({ id: 'usr_1' });
    await cafaye.identity.getCurrentUser({ headers: { Authorization: 'Bearer explicit' } });

    assert.equal(fetchImpl.requests[0].headers.authorization, 'Bearer explicit');
  });

  it('picks up a rotated credential on the next request', async () => {
    // Why the attachment is per request rather than per client: a long-lived Node
    // process outlives a token, and a client that captured it at construction
    // cannot be given a new one without being thrown away.
    const { cafaye, fetchImpl } = client({ credentials: { token: SESSION_TOKEN } });
    fetchImpl.reply({ id: 'usr_1' });

    await cafaye.identity.getCurrentUser();
    assert.equal(cafaye.credentialKind, 'session');

    cafaye.setCredentials({ token: API_TOKEN });
    assert.equal(cafaye.credentialKind, 'apiToken');
    await cafaye.identity.getCurrentUser();
    cafaye.setCredentials(null);
    assert.equal(cafaye.credentialKind, null);
    await cafaye.identity.getCurrentUser();

    assert.deepEqual(
      fetchImpl.requests.map((r) => r.headers.authorization),
      [`Bearer ${SESSION_TOKEN}`, `Bearer ${API_TOKEN}`, undefined],
    );
    // And the cookie followed the shape, not the instance: it was there for the
    // session and it is gone now that the credential is an api token.
    assert.equal(fetchImpl.requests[0].headers.cookie, `__Host-session=${SESSION_TOKEN}`);
    assert.equal(fetchImpl.requests[1].headers.cookie, undefined);
  });

  it('refuses a credential that could break a header, at construction', async () => {
    // undici validates header values, so this protection belongs to the platform
    // and not to this package. A CR or an LF in a credential is header injection
    // on any runtime that does not validate, and a blank one is a mistake worth
    // reporting now rather than as a 401 later.
    for (const token of ['', '   ', 'a\r\nX-Admin: true', `cafaye_${'A'.repeat(42)} tail`]) {
      assert.throws(
        () => new Cafaye({ baseUrl: 'https://cafaye.example.com', credentials: { token } }),
        (error) => error instanceof CafayeConfigurationError,
        `the constructor accepted ${JSON.stringify(token)}`,
      );
    }
  });

  it('sends the caller\'s own default headers on every request', async () => {
    // `Idempotency-Key` is a header in core's conventions and `headers` is part of
    // every generated operation, so a consumer can always add one per call — but a
    // tracing header that belongs on all of them belongs in the constructor.
    const { cafaye, fetchImpl } = client({ headers: { 'x-trace-id': 'abc' } });
    fetchImpl.reply({ id: 'usr_1' });
    await cafaye.identity.getCurrentUser();
    await cafaye.identity.getCurrentUser({ headers: { 'idempotency-key': 'key-1' } });

    assert.equal(fetchImpl.requests[0].headers['x-trace-id'], 'abc');
    assert.equal(fetchImpl.requests[1].headers['x-trace-id'], 'abc');
    assert.equal(fetchImpl.requests[1].headers['idempotency-key'], 'key-1');
  });
});

describe('failures, through the real generated transport', () => {
  it('turns a 401 problem document into a typed exception', async () => {
    const { cafaye, fetchImpl } = client({ credentials: { token: SESSION_TOKEN } });
    fetchImpl.reply(problem({ code: 'unauthorized', status: 401 }), { status: 401 });

    await assert.rejects(
      () => cafaye.identity.getCurrentUser(),
      (error) => {
        assert.ok(error instanceof CafayeUnauthenticatedError);
        assert.ok(error instanceof CafayeProblemError);
        assert.equal(error.kind, 'problem');
        assert.equal(error.status, 401);
        assert.equal(error.code, 'unauthorized');
        assert.equal(error.type, 'https://errors.cafaye.com/unauthorized');
        assert.equal(error.traceId, '0af7651916cd43dd8448eb211c80319c');
        assert.match(error.message, /identity\.getCurrentUser/);
        return true;
      },
    );
  });

  it('turns a 422 into a validation error with its per-field failures', async () => {
    const { cafaye, fetchImpl } = client();
    fetchImpl.reply(
      problem({
        code: 'validation_failed',
        status: 422,
        errors: [{ field: 'email', code: 'invalid_format' }],
      }),
      { status: 422 },
    );

    await assert.rejects(
      () => cafaye.identity.registerUser({ body: { email: 'nope', password: 'x'.repeat(20) } }),
      (error) => {
        assert.ok(error instanceof CafayeValidationError);
        assert.deepEqual(error.errors, [{ field: 'email', code: 'invalid_format' }]);
        return true;
      },
    );
  });

  it('turns a proxy\'s HTML 502 into a protocol error, keeping the excerpt', async () => {
    // "A response that is not a problem is not an error" — it is an error, but
    // not a *problem*, and giving it a cafaye `code` would be inventing one.
    const { cafaye, fetchImpl } = client();
    fetchImpl.reply('<html><h1>502 Bad Gateway</h1></html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    });

    await assert.rejects(
      () => cafaye.identity.getCurrentUser(),
      (error) => {
        assert.ok(error instanceof CafayeProtocolError);
        assert.equal(error.kind, 'protocol');
        assert.equal(error.status, 502);
        assert.equal(error.contentType, 'text/html');
        assert.match(error.bodySnippet, /502 Bad Gateway/);
        return true;
      },
    );
  });

  it('refuses to call a 200 that carries a problem document a success', async () => {
    // The brief's other edge. Returning the body would hand the caller a `Problem`
    // where its types promised a `User`: a TypeError three frames from the
    // mistake, instead of a diagnosis at it.
    const { cafaye, fetchImpl } = client();
    fetchImpl.reply(problem({ code: 'internal', status: 500 }), { status: 200 });

    await assert.rejects(
      () => cafaye.identity.getCurrentUser(),
      (error) => {
        assert.ok(error instanceof CafayeProtocolError);
        assert.equal(error.status, 200);
        assert.equal(error.problemShaped, true);
        return true;
      },
    );
  });

  it('returns a 200 that is not problem-shaped, even when it has a status member', async () => {
    // The false-positive check for the rule above. `identity`'s `/healthz` really
    // does answer `{ status: 'ok' }`, and it has to keep working — the rule
    // requires all three of `type`, `title` and `status`, and none of the six
    // documents' success schemas has all three.
    const { cafaye, fetchImpl } = client();
    fetchImpl.reply({ status: 'ok' }, { status: 200 });
    const health = await cafaye.identity.liveness();
    assert.equal(health.status, 'ok');
  });

  it('returns a 204 with no body at all', async () => {
    // `DELETE /v1/session` answers 204, and its generated response type is `void`.
    // What matters here is that nothing was thrown: the bodyless 2xx takes the
    // generated transport's empty-body branch, and the wrapper hands back whatever
    // the transport produced rather than inventing a value. The exact empty value
    // is the generated tree's business, so the assertion is "there is no error
    // here" and not a particular shape.
    const { cafaye, fetchImpl } = client({ credentials: { token: SESSION_TOKEN } });
    fetchImpl.reply(null, { status: 204 });
    const result = await cafaye.identity.deleteSession();
    assert.ok(!isCafayeError(result), 'a 204 produced an error');
    assert.ok(result === undefined || result === null || typeof result === 'object');
    assert.equal(fetchImpl.requests[0].headers.cookie, `__Host-session=${SESSION_TOKEN}`);
  });

  it('maps a network failure to a network error with a reason, and no status', async () => {
    // The brief: "A network failure is not an HTTP error and has no status." It
    // does not have one, and `status === null` is how a caller tells.
    const fetchImpl = recordingTransport();
    fetchImpl.respondWith(() => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND identity.example.com'), {
          code: 'ENOTFOUND',
        }),
      });
    });
    const cafaye = new Cafaye({ baseUrl: 'https://cafaye.example.com', fetch: fetchImpl });

    await assert.rejects(
      () => cafaye.identity.getCurrentUser(),
      (error) => {
        assert.ok(error instanceof CafayeNetworkError);
        assert.ok(error instanceof CafayeError);
        assert.ok(!(error instanceof CafayeTimeoutError), 'a DNS failure is not a timeout');
        assert.equal(error.kind, 'network');
        assert.equal(error.status, null, 'a network failure must not carry a status');
        assert.equal(error.reason, 'dns');
        assert.equal(error.code, 'ENOTFOUND');
        // The whole chain is kept. undici's `TypeError: fetch failed` has a
        // `cause`, and the errno is on the cause's cause; a wrapper that
        // summarised the failure into a string would have thrown away the only
        // place Node records what went wrong.
        assert.equal(error.cause.message, 'fetch failed');
        assert.equal(error.cause.cause.code, 'ENOTFOUND');
        return true;
      },
    );
  });

  it("tells a caller's own abort from a timeout", async () => {
    // Both arrive as an aborted request, and only one of them is a failure of
    // anything: `aborted` is the caller's signal firing, which must not be
    // retried by a wrapper that does not know whose signal it was.
    const fetchImpl = recordingTransport();
    fetchImpl.respondWith(abortingTransport);
    const cafaye = new Cafaye({ baseUrl: 'https://cafaye.example.com', fetch: fetchImpl });

    const controller = new AbortController();
    const pending = cafaye.identity.getCurrentUser({ signal: controller.signal });
    // The deadline is installed in a `requestValidator`, which the transport
    // awaits before it builds the Request, so the abort below lands before the
    // transport has a signal to listen to. `abortingTransport` handles that the
    // way the platform's own `fetch` does — by rejecting immediately when the
    // signal is already aborted — and that is what makes this a real assertion
    // about `reason` rather than a race.
    controller.abort();
    await assert.rejects(pending, (error) => {
      assert.ok(error instanceof CafayeNetworkError);
      assert.ok(!(error instanceof CafayeTimeoutError), 'a caller abort is not a timeout');
      assert.equal(error.reason, 'aborted');
      assert.equal(error.status, null);
      return true;
    });
  });

  it('applies a deadline, and a deadline that fires is a timeout', async (t) => {
    // THE FAKE CLOCK. `node:test`'s mock timers replace the global `setTimeout`,
    // so the deadline this class installs is driven by `tick()` rather than by
    // wall time: no sleep, no flake, and a thirty-second timeout costs no
    // thirty seconds. The class uses its own `setTimeout` rather than
    // `AbortSignal.timeout` for exactly this reason — the platform's version uses
    // an internal timer that no test clock can reach, which was found by writing
    // this test and watching the event loop drain past a pending deadline.
    const fetchImpl = recordingTransport();
    fetchImpl.respondWith(abortingTransport);
    const cafaye = new Cafaye({
      baseUrl: 'https://cafaye.example.com',
      fetch: fetchImpl,
      timeoutMs: 30_000,
    });

    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const pending = cafaye.identity.getCurrentUser();
      // The deadline is installed in a `requestValidator`, which the transport
      // awaits before it builds the `Request`, and the call chain from here to the
      // transport is a handful of microtask hops. `flush` drains them. It is a
      // macrotask yield, not a timed wait: there is no interval, no delay and
      // nothing to be early or late against.
      await flush();
      assert.equal(fetchImpl.requests.length, 1, 'the request never reached the transport');
      assert.equal(fetchImpl.requests[0].request.signal.aborted, false);

      t.mock.timers.tick(29_999);
      assert.equal(
        fetchImpl.requests[0].request.signal.aborted,
        false,
        'the deadline fired a millisecond early',
      );

      t.mock.timers.tick(1);
      await assert.rejects(pending, (error) => {
        assert.ok(error instanceof CafayeTimeoutError);
        assert.ok(error instanceof CafayeNetworkError, 'a caller retrying networks must catch timeouts');
        assert.equal(error.reason, 'timeout');
        assert.equal(error.timeoutMs, 30_000);
        assert.equal(error.status, null);
        assert.match(error.message, /30000ms/);
        return true;
      });
    } finally {
      t.mock.timers.reset();
    }
  });

  it('does not hold a Node process open for a deadline it will never reach', async () => {
    // A library that kept a process alive for thirty seconds after its last
    // request would break every graceful-shutdown test in the application using
    // it. The deadline is installed with an unref'd timer, and this is the
    // assertion: the transport saw a signal, the request succeeded, and the timer
    // was cleared on the way out rather than left pending.
    const fetchImpl = recordingTransport();
    fetchImpl.reply({ id: 'usr_1' });
    const cafaye = new Cafaye({
      baseUrl: 'https://cafaye.example.com',
      fetch: fetchImpl,
      timeoutMs: 30_000,
    });
    await cafaye.identity.getCurrentUser();
    // Nothing to observe directly — `unref` is a property of the process, not of
    // the object — so what is asserted is the part that IS observable: the request
    // completed and the signal was never aborted by the deadline that was set up
    // for it.
    assert.equal(fetchImpl.requests[0].request.signal.aborted, false);
  });

  it("leaves the caller's signal alone when there is no deadline", async () => {
    // `timeoutMs: 0` disables the timeout, and "disables" means it does not
    // compose a signal of its own. Identity is not assertable — the platform
    // builds a dependent signal inside `new Request`, so `request.signal` is
    // never the object that was passed in — so what is asserted is the behaviour
    // that matters: the caller's controller still governs the request, and
    // aborting it aborts the request.
    const fetchImpl = recordingTransport();
    fetchImpl.respondWith(abortingTransport);
    const cafaye = new Cafaye({
      baseUrl: 'https://cafaye.example.com',
      fetch: fetchImpl,
      timeoutMs: 0,
    });
    const controller = new AbortController();
    const pending = cafaye.identity.getCurrentUser({ signal: controller.signal });
    await flush();
    assert.equal(fetchImpl.requests.length, 1);
    assert.equal(fetchImpl.requests[0].request.signal.aborted, false);

    controller.abort();
    assert.equal(fetchImpl.requests[0].request.signal.aborted, true, "the caller's abort was ignored");
    await assert.rejects(pending, (error) => {
      assert.ok(error instanceof CafayeNetworkError);
      assert.equal(error.reason, 'aborted');
      return true;
    });
  });

  it('gives every request its own deadline rather than sharing one', async () => {
    // A deadline created once at construction would be a deadline for the first
    // request only, and a long-lived process would then have none at all. Two
    // requests, two signals, and they are not the same object.
    const fetchImpl = recordingTransport();
    fetchImpl.reply({ id: 'usr_1' });
    const cafaye = new Cafaye({
      baseUrl: 'https://cafaye.example.com',
      fetch: fetchImpl,
      timeoutMs: 30_000,
    });
    await cafaye.identity.getCurrentUser();
    await cafaye.identity.getCurrentUser();

    const [first, second] = fetchImpl.requests;
    assert.ok(first.request.signal, 'no signal reached the transport');
    assert.ok(second.request.signal);
    assert.notEqual(first.request.signal, second.request.signal);
    assert.equal(first.request.signal.aborted, false);
  });

  it('refuses a nonsense timeout at construction, where the mistake is', async () => {
    for (const timeoutMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new Cafaye({ baseUrl: 'https://cafaye.example.com', timeoutMs }),
        (error) => {
          assert.ok(error instanceof CafayeConfigurationError);
          assert.match(error.message, /timeoutMs/);
          return true;
        },
        `the constructor accepted timeoutMs: ${String(timeoutMs)}`,
      );
    }
  });
});

describe('the class, at construction', () => {
  it('throws rather than guessing when nothing says where requests go', async () => {
    for (const name of ENV_NAMES) delete process.env[name];
    assert.throws(
      () => new Cafaye(),
      (error) => {
        assert.ok(error instanceof CafayeConfigurationError);
        assert.equal(error.kind, 'configuration');
        assert.doesNotMatch(error.message, /localhost/i);
        return true;
      },
    );
  });

  it('takes the base URL from the environment when the caller gives none', async () => {
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.CAFAYE_BASE_URL = 'https://from-env.example.com';
    const cafaye = new Cafaye();
    assert.equal(cafaye.baseUrls.courier, 'https://from-env.example.com');
  });

  it('uses the host\'s own origin last, and only if there is one', () => {
    for (const name of ENV_NAMES) delete process.env[name];
    Object.defineProperty(globalThis, 'location', {
      value: { origin: 'https://app.example.com' },
      configurable: true,
    });
    assert.equal(new Cafaye().baseUrls.muse, 'https://app.example.com');
  });
});

describe('nothing is logged', () => {
  it('writes nothing to the console, to stdout or to stderr, on any path', async () => {
    // The brief: "Never log a token, a cookie, or a JWT. Not at debug level, not
    // in an error message, not in a thrown exception's message." The only way to
    // guarantee that for a library is to emit nothing — a debug log is a log
    // level somebody disables in production and pastes into a bug report.
    const written = [];
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
      trace: console.trace,
      dir: console.dir,
      stdout: process.stdout.write.bind(process.stdout),
      stderr: process.stderr.write.bind(process.stderr),
    };
    const record = (...args) => {
      written.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    };
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir']) {
      console[method] = record;
    }
    process.stdout.write = record;
    process.stderr.write = record;

    try {
      const fetchImpl = recordingTransport();

      // success
      const ok = new Cafaye({ baseUrl: 'https://cafaye.example.com', fetch: fetchImpl, credentials: { token: SESSION_TOKEN } });
      fetchImpl.reply({ id: 'usr_1' });
      await ok.identity.getCurrentUser();

      // a problem document
      fetchImpl.reply(problem({ code: 'unauthorized', status: 401 }), { status: 401 });
      await ok.identity.getCurrentUser().catch(() => {});

      // a protocol error with a body excerpt
      fetchImpl.reply('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } });
      await ok.identity.getCurrentUser().catch(() => {});

      // a network failure
      fetchImpl.respondWith(() => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      });
      await ok.identity.getCurrentUser().catch(() => {});

      // a configuration error
      for (const name of ENV_NAMES) delete process.env[name];
      try {
        new Cafaye();
      } catch {
        /* the assertion below is the point */
      }
    } finally {
      for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir']) {
        console[method] = original[method];
      }
      process.stdout.write = original.stdout;
      process.stderr.write = original.stderr;
    }

    assert.deepEqual(
      written,
      [],
      `this package wrote ${written.length} record(s) to the console or to a stream:\n${written.join('\n')}`,
    );
  });
});
