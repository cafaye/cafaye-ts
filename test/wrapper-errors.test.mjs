// The exception hierarchy, and the two edges of the contract it has to cover.
//
// The brief's requirement: "Maps RFC 9457 problem responses to typed exceptions.
// Every service returns `application/problem+json` … One exception type carrying
// the problem's `type`, `title`, `status`, `detail` and any extension members, and
// a small hierarchy for the cases worth catching specifically (unauthenticated,
// forbidden, not found, conflict, validation) — plus a fallback that is still
// typed for anything else, because a client that throws a bare `Error` on an
// unrecognised problem type has moved the problem, not solved it."
//
// The three questions the brief then asks to be answered rather than assumed:
//
//   - "A response that is not a problem is not an error, and a problem-shaped body
//     with a 200 is not a success. Decide, test, and document what you do with
//     each."
//   - "A network failure is not an HTTP error and has no status. One error type
//     that covers both, with the distinction queryable — or two types and a stated
//     rule for which one you throw. Say which and why."
//   - "A timeout and a DNS failure are different problems for a caller. If your
//     design collapses them, say so rather than pretending not to."
//
// The answers are in `src/cafaye/errors.ts`'s header and asserted here. In short:
// `CafayeProblemError` for a problem document, `CafayeProtocolError` for a
// response that broke the contract in either direction, `CafayeNetworkError` with
// a `reason` for anything that produced no response at all, and
// `CafayeConfigurationError` for a mistake that meant no request was made.
//
// The `code`-first mapping is tested against the reserved list in core's
// `docs/openapi-conventions.md`, so a change to that list shows up here.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadDist } from './lib/dist.mjs';

const {
  CafayeError,
  CafayeProblemError,
  CafayeUnauthenticatedError,
  CafayeForbiddenError,
  CafayeNotFoundError,
  CafayeRateLimitedError,
  CafayeConflictError,
  CafayeIdempotencyKeyReusedError,
  CafayeValidationError,
  CafayeProtocolError,
  CafayeNetworkError,
  CafayeTimeoutError,
  CafayeConfigurationError,
  isCafayeError,
  looksLikeProblem,
  classifyNetworkFailure,
  problemErrorFrom,
  protocolErrorFrom,
} = await loadDist('cafaye', 'errors.js');

/** core's reserved codes, quoted from `docs/openapi-conventions.md`. */
const RESERVED = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 422,
  rate_limited: 429,
  idempotency_key_reused: 409,
  internal: 500,
  unavailable: 503,
};

function problem({ code, status, ...overrides } = {}) {
  return {
    type: code === undefined ? 'about:blank' : `https://errors.cafaye.com/${code}`,
    title: code === undefined ? 'Something went wrong' : code.replace(/_/g, ' '),
    status: status ?? 500,
    detail: 'a specific thing that happened once',
    instance: '/v1/users',
    code,
    trace_id: '0af7651916cd43dd8448eb211c80319c',
    ...overrides,
  };
}

describe('the hierarchy', () => {
  it('has a base every one of them descends from, and a predicate that finds them', () => {
    const every = [
      new CafayeProblemError('x', { type: 'about:blank', title: 'x', status: 500 }),
      new CafayeUnauthenticatedError('x', { type: 't', title: 'x', status: 401 }),
      new CafayeForbiddenError('x', { type: 't', title: 'x', status: 403 }),
      new CafayeNotFoundError('x', { type: 't', title: 'x', status: 404 }),
      new CafayeRateLimitedError('x', { type: 't', title: 'x', status: 429 }),
      new CafayeConflictError('x', { type: 't', title: 'x', status: 409 }),
      new CafayeIdempotencyKeyReusedError('x', { type: 't', title: 'x', status: 409 }),
      new CafayeValidationError('x', { type: 't', title: 'x', status: 422 }),
      new CafayeProtocolError('x', { status: 502 }),
      new CafayeNetworkError('x', { reason: 'dns' }),
      new CafayeTimeoutError('x', {}),
      new CafayeConfigurationError('x'),
    ];
    for (const error of every) {
      assert.ok(error instanceof Error, `${error.name} is not an Error`);
      assert.ok(error instanceof CafayeError, `${error.name} does not descend from CafayeError`);
      assert.ok(isCafayeError(error), `isCafayeError does not accept ${error.name}`);
      assert.equal(typeof error.name, 'string');
      assert.ok(error.name.length > 0, `${error.name} has no name`);
    }
    assert.equal(isCafayeError(new Error('plain')), false, 'a bare Error passed isCafayeError');
    assert.equal(isCafayeError(null), false);
    assert.equal(isCafayeError('a string'), false);
  });

  it('carries `kind` on every error, so one handler can branch without instanceof', () => {
    assert.equal(new CafayeProblemError('x', { type: 't', title: 'x', status: 500 }).kind, 'problem');
    assert.equal(new CafayeProtocolError('x', { status: 502 }).kind, 'protocol');
    assert.equal(new CafayeNetworkError('x', { reason: 'dns' }).kind, 'network');
    assert.equal(new CafayeConfigurationError('x').kind, 'configuration');
  });

  it('gives `status` a number for anything that had a response and null otherwise', () => {
    // The brief's "a network failure … has no status", made into one assertion
    // so the two halves cannot drift apart.
    assert.equal(new CafayeProblemError('x', { type: 't', title: 'x', status: 409 }).status, 409);
    assert.equal(new CafayeProtocolError('x', { status: 502 }).status, 502);
    assert.equal(new CafayeNetworkError('x', { reason: 'dns' }).status, null);
    assert.equal(new CafayeTimeoutError('x', {}).status, null);
    assert.equal(new CafayeConfigurationError('x').status, null);
  });

  it('keeps the underlying cause, because it is where the platform code is', () => {
    // A CafayeNetworkError that swallowed the TypeError would have swallowed
    // `cause.code`, which is the only place Node records the difference between
    // a refused connection and a certificate that expired.
    const cause = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const error = new CafayeNetworkError('x', { reason: 'connection', code: 'ECONNREFUSED', cause });
    assert.equal(error.cause, cause);
    assert.equal(error.code, 'ECONNREFUSED');
  });

  it('does not put its own brand in the serialised form', () => {
    // The cross-copy marker is a registered Symbol defined non-enumerable. If it
    // were enumerable it would appear in `JSON.stringify(error)`, which is to
    // say in every log line anybody ever writes with an error in it.
    const serialised = JSON.stringify(new CafayeProblemError('x', { type: 't', title: 'x', status: 500 }));
    assert.ok(!serialised.includes('cafaye.ts.error'), `the brand leaked into ${serialised}`);
    assert.ok(serialised.includes('"status":500'), `the useful members are missing: ${serialised}`);
  });

  it('recognises a cafaye error from a second copy of this package', () => {
    // The scenario is two versions in one dependency tree. `instanceof` is false
    // across the boundary and the consumer's error handling silently stops
    // working, which reads as a bug in their code.
    const foreign = Object.create(CafayeProblemError.prototype);
    Object.defineProperty(foreign, Symbol.for('cafaye.ts.error'), { value: true });
    Object.defineProperty(foreign, 'message', { value: 'from another copy', enumerable: false });
    assert.equal(foreign instanceof CafayeProblemError, true, 'the premise of this test is wrong');
    const impostor = { message: 'x', kind: 'problem' };
    Object.defineProperty(impostor, Symbol.for('cafaye.ts.error'), { value: true });
    assert.equal(impostor instanceof CafayeProblemError, false, 'the premise of this test is wrong');
    assert.equal(isCafayeError(impostor), true);
  });
});

describe('mapping a problem document to a class', () => {
  for (const [code, status] of Object.entries(RESERVED)) {
    it(`maps core's \`${code}\` (${status})`, () => {
      const error = problemErrorFrom({ body: problem({ code, status }), status, operation: 'identity.me' });
      assert.equal(error.kind, 'problem');
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.type, `https://errors.cafaye.com/${code}`);
      assert.ok(error instanceof CafayeProblemError, `${code} is not a CafayeProblemError`);
      assert.equal(error.operation, 'identity.me');
    });
  }

  it('picks the specific class for each case worth catching', () => {
    const cases = [
      ['unauthorized', 401, CafayeUnauthenticatedError],
      ['forbidden', 403, CafayeForbiddenError],
      ['not_found', 404, CafayeNotFoundError],
      ['rate_limited', 429, CafayeRateLimitedError],
      ['conflict', 409, CafayeConflictError],
      ['idempotency_key_reused', 409, CafayeIdempotencyKeyReusedError],
      ['validation_failed', 422, CafayeValidationError],
    ];
    for (const [code, status, Klass] of cases) {
      const error = problemErrorFrom({ body: problem({ code, status }), status });
      assert.ok(error instanceof Klass, `${code} did not produce a ${Klass.name}`);
      assert.ok(error instanceof CafayeProblemError);
      // And it is exactly, so `error.constructor` in a log is readable.
      assert.equal(error.constructor, Klass);
    }
  });

  it('makes idempotency_key_reusable a conflict as well, because it is one', () => {
    // core: "Replay with the same key but a different body returns 409
    // `idempotency_key_reused`." A caller retrying a conflict must check this one
    // first, because the retry cannot succeed — so it has to be catchable both
    // as the general case and as the specific one.
    const error = problemErrorFrom({
      body: problem({ code: 'idempotency_key_reused', status: 409 }),
      status: 409,
    });
    assert.ok(error instanceof CafayeConflictError);
    assert.ok(error instanceof CafayeIdempotencyKeyReusedError);
  });

  it('falls back to a still-typed error for a code nobody has heard of', () => {
    // The brief's sentence, turned into an assertion: "a client that throws a
    // bare `Error` on an unrecognised problem type has moved the problem, not
    // solved it."
    const error = problemErrorFrom({
      body: problem({ code: 'account_locked', status: 423 }),
      status: 423,
    });
    assert.equal(error.constructor, CafayeProblemError);
    assert.ok(error instanceof CafayeProblemError);
    assert.ok(error instanceof CafayeError);
    assert.equal(error.code, 'account_locked');
    assert.equal(error.status, 423);
    assert.match(error.message, /account_locked/);
  });

  it('uses the status when the service omitted the code', () => {
    for (const [status, Klass] of [
      [401, CafayeUnauthenticatedError],
      [403, CafayeForbiddenError],
      [404, CafayeNotFoundError],
      [409, CafayeConflictError],
      [422, CafayeValidationError],
      [429, CafayeRateLimitedError],
    ]) {
      const body = problem({ status });
      delete body.code;
      const error = problemErrorFrom({ body, status });
      assert.equal(error.constructor, Klass, `status ${status} did not map when code was absent`);
      assert.equal(error.code, null);
    }
  });

  it('prefers the code to the status when they disagree', () => {
    // core: "`type` is a stable … URI — the machine-readable contract" and
    // "`status` is repeated in the body". RFC 9457 makes `status` advisory, so
    // the code is the thing to branch on and the number is a fact about one
    // response that a service can get wrong.
    const error = problemErrorFrom({
      body: problem({ code: 'forbidden', status: 500 }),
      status: 500,
    });
    assert.ok(error instanceof CafayeForbiddenError);
    assert.equal(error.status, 500, 'the status is still reported, whatever class was chosen');
  });

  it('carries the per-field failures of a 422, and only a 422 has them', () => {
    // core: "`errors[]` appears only for 422 and lists per-field failures."
    const body = problem({
      code: 'validation_failed',
      status: 422,
      errors: [{ field: 'email', code: 'invalid_format' }],
    });
    const error = problemErrorFrom({ body, status: 422 });
    assert.ok(error instanceof CafayeValidationError);
    assert.deepEqual(error.errors, [{ field: 'email', code: 'invalid_format' }]);

    // And a validation error with no `errors` still has the member, empty,
    // rather than `undefined` — a caller iterating it does not need a guard.
    const bare = problemErrorFrom({ body: problem({ code: 'validation_failed', status: 422 }), status: 422 });
    assert.deepEqual(bare.errors, []);
  });

  it('puts unknown members in `extensions` and keeps the eight the fleet defines out', () => {
    // RFC 9457 is explicit that a problem document may carry extension members,
    // and core adds two of its own. A client that kept only the known set would
    // silently drop a field a service added yesterday.
    const body = problem({
      code: 'conflict',
      status: 409,
      retry_after_seconds: 30,
      billing: { invoice_id: 'in_1', nested: { reason: 'past_due' } },
      flag: true,
      list: ['a', 'b'],
    });
    const error = problemErrorFrom({ body, status: 409 });
    assert.deepEqual(error.extensions, {
      retry_after_seconds: 30,
      billing: { invoice_id: 'in_1', nested: { reason: 'past_due' } },
      flag: true,
      list: ['a', 'b'],
    });
    for (const known of ['type', 'title', 'status', 'detail', 'instance', 'code', 'trace_id', 'errors']) {
      assert.ok(!(known in error.extensions), `${known} should not be duplicated into extensions`);
    }
  });

  it('names the operation in the message, and keeps the trace id reachable', () => {
    const error = problemErrorFrom({
      body: problem({ code: 'not_found', status: 404 }),
      status: 404,
      operation: 'billing.getCustomer',
    });
    assert.match(error.message, /billing\.getCustomer/);
    assert.match(error.message, /404/);
    assert.equal(error.traceId, '0af7651916cd43dd8448eb211c80319c');
  });

  it('recognises a problem by its shape, not by a Content-Type', () => {
    // A mislabelled content type behind a proxy is common and the body is what
    // decides what a caller has to handle. And the check needs three members,
    // not one, or an arbitrary JSON error body from a gateway is a "problem".
    assert.equal(looksLikeProblem(problem({ code: 'conflict', status: 409 })), true);
    assert.equal(looksLikeProblem({ type: 'x', title: 'y' }), false, 'two members is not enough');
    assert.equal(looksLikeProblem({ type: 'x', title: 'y', status: '409' }), false, 'status must be a number');
    assert.equal(looksLikeProblem({ error: 'nope' }), false);
    assert.equal(looksLikeProblem([{ type: 'x', title: 'y', status: 1 }]), false, 'an array is not a problem');
    assert.equal(looksLikeProblem('a string'), false);
    assert.equal(looksLikeProblem(null), false);
  });
});

describe('the two edges of the contract', () => {
  it('treats a non-2xx that is not a problem as a protocol error, with a status and no problem', () => {
    // The brief: "A response that is not a problem is not an error." It is an
    // error — a 502 from a proxy is a failure — but it is not a *problem*, and
    // giving it `type` and `title` would be inventing a cafaye code.
    const error = protocolErrorFrom({
      status: 502,
      contentType: 'text/html',
      bodyText: '<html><body><h1>502 Bad Gateway</h1></body></html>',
      problemShaped: false,
      operation: 'identity.getCurrentUser',
    });
    assert.ok(error instanceof CafayeProtocolError);
    assert.ok(error instanceof CafayeError);
    assert.equal(error.kind, 'protocol');
    assert.equal(error.status, 502);
    assert.equal(error.contentType, 'text/html');
    assert.equal(error.problemShaped, false);
    assert.match(error.bodySnippet, /502 Bad Gateway/);
    assert.match(error.message, /502/);
  });

  it('treats a 200 carrying a problem document as a failure, not a success', () => {
    // The brief: "a problem-shaped body with a 200 is not a success. Decide, test,
    // and document what you do with each." It throws, because the alternative is
    // handing a caller a Problem where its types promised a User — a typed client
    // that quietly returns the wrong shape produces a TypeError three frames from
    // the mistake, and this produces a diagnosis AT the mistake.
    const error = protocolErrorFrom({
      status: 200,
      contentType: 'application/problem+json',
      bodyText: JSON.stringify(problem({ code: 'internal', status: 500 })),
      problemShaped: true,
      operation: 'identity.getCurrentUser',
    });
    assert.ok(error instanceof CafayeProtocolError);
    assert.equal(error.kind, 'protocol');
    assert.equal(error.status, 200);
    assert.equal(error.problemShaped, true);
    assert.match(error.message, /problem\+json/);
    assert.match(error.message, /not a success|2xx|HTTP 200/, 'the message does not explain the 2xx case');
  });

  it('drops the body excerpt entirely when something credential-shaped is in it', () => {
    // All-or-nothing, inherited from the redactor: a partially scrubbed excerpt
    // is a scrubber whose recogniser had a gap, and the gap is where the leak
    // comes from.
    const error = protocolErrorFrom({
      status: 500,
      contentType: 'text/plain',
      bodyText: 'upstream said: Authorization: Bearer cafaye_' + 'A'.repeat(43),
      problemShaped: false,
      secrets: [],
    });
    assert.equal(error.bodySnippet, null, `the excerpt survived: ${error.bodySnippet}`);
    assert.doesNotMatch(JSON.stringify(error), /cafaye_/);
  });

  it('keeps a clean excerpt, because a proxy 502 is undiagnosable without one', () => {
    const error = protocolErrorFrom({
      status: 504,
      contentType: 'text/plain',
      bodyText: 'upstream timed out after 60000ms',
      problemShaped: false,
    });
    assert.equal(error.bodySnippet, 'upstream timed out after 60000ms');
  });
});

describe('why a timeout is not a DNS failure', () => {
  // The brief: "A timeout and a DNS failure are different problems for a caller.
  // If your design collapses them, say so rather than pretending not to." They do
  // not collapse, and these are the error shapes Node 22 actually produces,
  // observed rather than described.
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const abort = new DOMException('This operation was aborted', 'AbortError');
  const withCode = (code, message) =>
    Object.assign(new TypeError(message ?? 'fetch failed'), { cause: { code, message } });

  it('tells a timeout from an abort', () => {
    assert.equal(classifyNetworkFailure(timeout).reason, 'timeout');
    assert.equal(classifyNetworkFailure(abort).reason, 'aborted');
    // The distinction matters because only one of them is a failure of anything:
    // an `aborted` request is the caller's own signal firing.
  });

  it('tells a name that did not resolve from a connection that was refused', () => {
    assert.equal(classifyNetworkFailure(withCode('ENOTFOUND')).reason, 'dns');
    assert.equal(classifyNetworkFailure(withCode('EAI_AGAIN')).reason, 'dns');
    assert.equal(classifyNetworkFailure(withCode('ECONNREFUSED')).reason, 'connection');
    assert.equal(classifyNetworkFailure(withCode('ECONNRESET')).reason, 'connection');
    assert.equal(classifyNetworkFailure(withCode('UND_ERR_SOCKET')).reason, 'connection');
  });

  it('tells a TLS fault from either, because retrying a bad certificate is how an outage becomes an incident', () => {
    assert.equal(classifyNetworkFailure(withCode('CERT_HAS_EXPIRED')).reason, 'tls');
    assert.equal(classifyNetworkFailure(withCode('UNABLE_TO_VERIFY_LEAF_SIGNATURE')).reason, 'tls');
    assert.equal(classifyNetworkFailure(withCode('ERR_TLS_CERT_ALTNAME_INVALID')).reason, 'tls');
  });

  it('tells undici\'s own timeouts from all of them', () => {
    for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
      assert.equal(classifyNetworkFailure(withCode(code)).reason, 'timeout', code);
    }
  });

  it('says "unknown" rather than guessing when it does not recognise the failure', () => {
    // The honest answer, and the one that matters: a wrapper that labels an
    // unrecognised failure "connection" is a wrapper that will eventually tell a
    // caller to retry something that must not be retried.
    assert.equal(classifyNetworkFailure(withCode('EHOSTUNREACH')).reason, 'connection');
    assert.equal(classifyNetworkFailure(new Error('something else')).reason, 'unknown');
    assert.equal(classifyNetworkFailure(undefined).reason, 'unknown');
    assert.equal(classifyNetworkFailure('a string').reason, 'unknown');
  });

  it('cannot classify a custom abort reason, and says so rather than pretending', () => {
    // A caller who calls `controller.abort()` with no reason gets an
    // `AbortError` DOMException, which is recognised. A caller who aborts with an
    // error of their own — the documented way to say why they stopped — produces
    // something this function has never seen, and with `timeoutMs: 0` the class
    // composes no signal of its own to replace it. The limitation is stated in
    // `errors.ts` and asserted here so that it stays stated: `unknown` is
    // information, and it is the honest information.
    assert.equal(
      classifyNetworkFailure(Object.assign(new Error('the user navigated away'), { code: 'ABORT_ERR' })).reason,
      'unknown',
    );
  });

  it('finds the platform code wherever Node put it', () => {
    // undici puts it on `cause`, and an error raised directly carries it on
    // itself. Both are read, and both are reported as the string Node uses.
    assert.equal(classifyNetworkFailure(withCode('ENOTFOUND')).code, 'ENOTFOUND');
    assert.equal(classifyNetworkFailure(Object.assign(new Error('x'), { code: 'ECONNRESET' })).code, 'ECONNRESET');
    // A `DOMException` carries a legacy numeric `code` — 20 for AbortError, 23 for
    // TimeoutError — and neither is reported as a platform code, because both
    // are already identified by name and `23` in a field documented as an errno
    // would be a different kind of wrong.
    assert.equal(classifyNetworkFailure(timeout).code, null);
    assert.equal(classifyNetworkFailure(abort).code, null);
    assert.equal(classifyNetworkFailure(new Error('x')).code, null);
  });

  it('makes a timeout catchable as a network error and as itself', () => {
    const timeoutError = new CafayeTimeoutError('x', { timeoutMs: 30_000 });
    assert.ok(timeoutError instanceof CafayeTimeoutError);
    assert.ok(timeoutError instanceof CafayeNetworkError, 'a caller retrying networks must catch timeouts');
    assert.ok(timeoutError instanceof CafayeError);
    assert.equal(timeoutError.reason, 'timeout');
    assert.equal(timeoutError.timeoutMs, 30_000);
    assert.equal(timeoutError.status, null);
  });
});
