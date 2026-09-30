// One place decides where requests go, and it is not localhost.
//
// The brief's requirement, in its own words: "One place that decides where
// requests go, from an explicit option, an environment variable, or the host's
// own origin — in a documented precedence order, with a test per precedence step
// and a test that resolution never silently defaults to localhost in a way a
// consumer would not notice."
//
// WHY THAT LAST CLAUSE IS THE WHOLE POINT
//
// The generated clients each carry a documented default `baseUrl` — the public
// SaaS URL for that service. A client that constructs one without saying where
// it points sends the consumer's traffic to somebody else's production. That is
// not hypothetical: it is why `README.md` says "There is deliberately no
// pre-built client to grab", and why the generated `client` const is not
// reachable from any entrypoint.
//
// A `localhost` fallback would be the same failure wearing a friendlier hat. A
// self-hoster running the fleet on a laptop would be served by it, which is why
// it is tempting; and a developer whose resolution silently became
// `http://localhost:3000` would spend an afternoon on a connection refused
// against a service they never asked for. The rule this file enforces is
// therefore: resolution either produces a URL somebody configured, or it
// throws. There is no third outcome, and the assertion below walks the thrown
// message looking for `localhost` to keep it that way.
//
// THE PRECEDENCE, and why this order
//
//   1. `baseUrl[service]`     a per-service record, when the option is a record
//   2. `baseUrl`             a single string, which applies to all six
//   3. `CAFAYE_<SERVICE>_BASE_URL`   the environment, per service
//   4. `CAFAYE_BASE_URL`     the environment, for all six
//   5. the host's own origin  `globalThis.location.origin`, where there is one
//   6. throw
//
// Explicit beats ambient, and more specific beats less, in that order. Steps 1
// and 2 are the same source with two shapes, and the per-service entry wins
// because a consumer who bothered to write six URLs meant them. Steps 3 and 4
// are the same source, and the per-service variable wins for the same reason —
// it is also derived from the one service list rather than written out six
// times, which is this repository's standing objection to a second copy of
// anything (see `AGENTS.md`, "there is no second place to update").
//
// Step 5 is last because it is the weakest possible statement of intent: it
// says "wherever this code happens to be running", which is right for a browser
// talking to its own origin and wrong for a Node process, which has no
// `location` at all. A Node process that reaches step 5 is a misconfiguration,
// and it gets a `CafayeConfigurationError` naming every source it consulted.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { loadDist } from './lib/dist.mjs';

const { resolveBaseUrl, BASE_URL_ENV, baseUrlEnvFor } = await loadDist('cafaye', 'base-url.js');

/** Every env var this module reads, so a test can prove it left none set. */
const ENV_NAMES = [BASE_URL_ENV, 'identity', 'billing', 'muse', 'darkroom', 'pantry', 'courier']
  .flatMap((s) => (s === BASE_URL_ENV ? [s] : [baseUrlEnvFor(s)]));

const saved = {};
for (const name of ENV_NAMES) saved[name] = process.env[name];

function setEnv(values) {
  for (const name of ENV_NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

/** Install a `location`, the way a browser has one. Node 22 does not. */
function setLocation(origin) {
  Object.defineProperty(globalThis, 'location', { value: { origin }, configurable: true });
}

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  delete globalThis.location;
});

describe('base URL precedence', () => {
  it('derives the per-service variable name from the service name', () => {
    // One name, derived. Six hand-written `CAFAYE_X_BASE_URL` strings would be a
    // second list of the six services, and a second list is a second thing to
    // forget.
    assert.equal(baseUrlEnvFor('identity'), 'CAFAYE_IDENTITY_BASE_URL');
    assert.equal(baseUrlEnvFor('courier'), 'CAFAYE_COURIER_BASE_URL');
  });

  it('step 1: a per-service record beats everything else', () => {
    setEnv({ CAFAYE_BASE_URL: 'https://env.example.com', CAFAYE_IDENTITY_BASE_URL: 'https://envid.example.com' });
    setLocation('https://host.example.com');
    const resolved = resolveBaseUrl('identity', {
      explicit: { identity: 'https://explicit-identity.example.com', courier: 'https://x.example.com' },
      env: process.env,
      hostOrigin: 'https://host.example.com',
    });
    assert.equal(resolved, 'https://explicit-identity.example.com');
  });

  it('step 2: a single string applies to all six services', () => {
    setEnv({ CAFAYE_BASE_URL: 'https://env.example.com' });
    for (const service of ['identity', 'billing', 'muse', 'darkroom', 'pantry', 'courier']) {
      assert.equal(
        resolveBaseUrl(service, {
          explicit: 'https://one.example.com',
          env: process.env,
          hostOrigin: 'https://host.example.com',
        }),
        'https://one.example.com',
        `a single baseUrl did not reach ${service}`,
      );
    }
  });

  it('step 2 loses to step 1 for the one service named, and nothing else', () => {
    setEnv({});
    const resolved = resolveBaseUrl('identity', {
      explicit: { identity: 'https://identity.example.com' },
      env: process.env,
      hostOrigin: 'https://host.example.com',
    });
    assert.equal(resolved, 'https://identity.example.com');
  });

  it('step 3: the per-service environment variable beats the general one', () => {
    setEnv({
      CAFAYE_BASE_URL: 'https://env.example.com',
      CAFAYE_BILLING_BASE_URL: 'https://billing.example.com',
    });
    setLocation('https://host.example.com');
    assert.equal(
      resolveBaseUrl('billing', { env: process.env, hostOrigin: 'https://host.example.com' }),
      'https://billing.example.com',
    );
    // ...and a service it does not name still gets the general one.
    assert.equal(
      resolveBaseUrl('courier', { env: process.env, hostOrigin: 'https://host.example.com' }),
      'https://env.example.com',
    );
  });

  it('step 4: the general environment variable is used when no service is named', () => {
    setEnv({ CAFAYE_BASE_URL: 'https://env.example.com' });
    setLocation('https://host.example.com');
    assert.equal(
      resolveBaseUrl('muse', { env: process.env, hostOrigin: 'https://host.example.com' }),
      'https://env.example.com',
    );
  });

  it('step 5: the host origin is the last source before throwing', () => {
    setEnv({});
    assert.equal(
      resolveBaseUrl('pantry', { env: process.env, hostOrigin: 'https://app.example.com' }),
      'https://app.example.com',
    );
  });

  it('prefers the explicit option over the environment, and the environment over the host', () => {
    // The three-step ladder in one assertion, because a precedence order that is
    // only ever tested one pair at a time is an order nobody has checked.
    setEnv({ CAFAYE_BASE_URL: 'https://env.example.com' });
    setLocation('https://host.example.com');
    const both = { env: process.env, hostOrigin: 'https://host.example.com' };
    assert.equal(
      resolveBaseUrl('darkroom', { explicit: 'https://explicit.example.com', ...both }),
      'https://explicit.example.com',
    );
    assert.equal(resolveBaseUrl('darkroom', both), 'https://env.example.com');

    setEnv({});
    assert.equal(resolveBaseUrl('darkroom', both), 'https://host.example.com');
  });
});

describe('resolution never silently defaults', () => {
  it('throws when nothing is configured, rather than guessing', () => {
    setEnv({});
    for (const hostOrigin of [undefined, null, '']) {
      assert.throws(
        () => resolveBaseUrl('identity', { env: process.env, hostOrigin }),
        (error) => {
          assert.equal(error.name, 'CafayeConfigurationError');
          assert.equal(error.kind, 'configuration');
          assert.equal(error.status, null);
          return true;
        },
        `resolution invented a base URL for identity with hostOrigin ${JSON.stringify(hostOrigin)}`,
      );
    }
  });

  it('does not put localhost, or any host, in the message it throws', () => {
    // The assertion the brief asks for by name. A thrown error is the one place
    // a developer looks first, and an error that helpfully suggested
    // `http://localhost:3000` would be an invitation rather than a diagnosis.
    setEnv({});
    let message = '';
    try {
      resolveBaseUrl('identity', { env: process.env, hostOrigin: undefined });
      assert.fail('resolution did not throw');
    } catch (error) {
      message = `${error.message}`;
    }
    assert.doesNotMatch(message, /localhost/i, `the error suggests a host: ${message}`);
    assert.doesNotMatch(message, /127\.0\.0\.1|0\.0\.0\.0|::1/, `the error suggests a host: ${message}`);
  });

  it('names every source it consulted, so the fix is in the message', () => {
    setEnv({});
    try {
      resolveBaseUrl('courier', { env: process.env, hostOrigin: undefined });
      assert.fail('resolution did not throw');
    } catch (error) {
      assert.match(error.message, /baseUrl/, 'the option name is not in the message');
      assert.match(error.message, /CAFAYE_COURIER_BASE_URL/, 'the per-service variable is not named');
      assert.match(error.message, /CAFAYE_BASE_URL/, 'the general variable is not named');
    }
  });

  it('treats an empty or whitespace-only environment variable as unset', () => {
    // An empty base URL is not a base URL. Left alone it would concatenate into
    // a relative path and turn every call into a request against whatever the
    // runtime happened to consider the current origin, which is the same silent
    // default the brief is about with one more step of indirection.
    for (const empty of ['', '   ', '\t']) {
      setEnv({ CAFAYE_BASE_URL: empty });
      assert.throws(
        () => resolveBaseUrl('identity', { env: process.env, hostOrigin: undefined }),
        (error) => error.name === 'CafayeConfigurationError',
        `CAFAYE_BASE_URL=${JSON.stringify(empty)} was treated as a base URL`,
      );
    }
    // ...and the per-service variable is treated the same way, because the two
    // are the same source and a rule that applied to one of them only would be a
    // rule with a hole in the more specific of the two.
    setEnv({ CAFAYE_IDENTITY_BASE_URL: '  ' });
    assert.throws(() => resolveBaseUrl('identity', { env: process.env, hostOrigin: undefined }));
  });

  it('refuses a value that is not an absolute http(s) URL', () => {
    setEnv({});
    for (const bad of ['identity.example.com', '//identity.example.com', 'ftp://identity.example.com', '/v1']) {
      assert.throws(
        () => resolveBaseUrl('identity', { explicit: bad, env: process.env, hostOrigin: undefined }),
        (error) => {
          assert.equal(error.name, 'CafayeConfigurationError');
          assert.match(error.message, /absolute http/, `the message does not say what is wrong: ${error.message}`);
          return true;
        },
        `${JSON.stringify(bad)} was accepted as a base URL`,
      );
    }
  });

  it('refuses a host origin that is not http(s) either', () => {
    // `file://` and `chrome-extension://` are real `location.origin` values in a
    // browser doing something other than serving the app. A cafaye service is
    // never there.
    setEnv({});
    for (const origin of ['file://', 'chrome-extension://abc', 'not a url']) {
      assert.throws(
        () => resolveBaseUrl('identity', { env: process.env, hostOrigin: origin }),
        (error) => error.name === 'CafayeConfigurationError',
        `hostOrigin ${JSON.stringify(origin)} was accepted`,
      );
    }
  });

  it('normalises a trailing slash, so the reported URL is the one on the wire', () => {
    // The generated client concatenates `baseUrl + '/v1/me'` rather than
    // resolving one against the other (`getUrl` in its `core/utils.gen.ts`), so a
    // trailing slash produces a doubled separator in the path. The generated
    // `mergeConfigs` strips one; this strips them all and reports the result, so
    // `cafaye.baseUrls.x` is a thing a consumer can log and compare.
    setEnv({});
    for (const [given, expected] of [
      ['https://a.example.com/', 'https://a.example.com'],
      ['https://a.example.com///', 'https://a.example.com'],
      ['https://a.example.com/cafaye/', 'https://a.example.com/cafaye'],
      ['https://a.example.com/cafaye', 'https://a.example.com/cafaye'],
    ]) {
      assert.equal(
        resolveBaseUrl('identity', { explicit: given, env: process.env, hostOrigin: undefined }),
        expected,
        `${given} normalised to something other than ${expected}`,
      );
    }
  });

  it('keeps a path prefix, because a self-hoster may serve the fleet under one', () => {
    setEnv({});
    assert.equal(
      resolveBaseUrl('identity', {
        explicit: 'https://api.example.com/cafaye',
        env: process.env,
        hostOrigin: undefined,
      }),
      'https://api.example.com/cafaye',
    );
  });

  it('does not read the environment through a captured snapshot', () => {
    // A module that read `process.env` once at import time would pass every other
    // test in this file and then be wrong in a process that sets a variable
    // after loading the package — which is what a test harness, a Next.js
    // server, and every container runtime do.
    setEnv({});
    const opts = { env: process.env, hostOrigin: undefined };
    assert.throws(() => resolveBaseUrl('identity', opts));
    process.env.CAFAYE_BASE_URL = 'https://late.example.com';
    assert.equal(resolveBaseUrl('identity', opts), 'https://late.example.com');
  });

  it('reads globalThis.location when the caller does not pass a host origin', () => {
    // The one place `location` is read at all, and it is read per call rather
    // than captured, for the same reason as the environment above.
    setEnv({});
    setLocation('https://app.example.com');
    assert.equal(resolveBaseUrl('identity', { env: process.env }), 'https://app.example.com');
  });
});
