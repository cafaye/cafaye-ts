// A credential that reaches a log is a credential that has leaked.
//
// This package is the one place in a consumer's application that touches every
// credential it has: it reads the token out of an option, puts it on a header,
// and constructs exception objects describing what went wrong. The brief for
// this packet is blunt about which of those three is the risk — "Never log a
// token, a cookie, or a JWT. Not at debug level, not in an error message, not
// in a thrown exception's message. This is the most important constraint in the
// brief" — and this file is the mechanism that makes it structural rather than
// a matter of remembering to be careful in six places.
//
// THE RULE, AND WHY IT IS ALL-OR-NOTHING
//
// `redact()` returns the whole string replaced by a marker, or the string
// unchanged. There is no third behaviour, and that is the point. A scrubber that
// removes the 43 characters it recognised and returns the other 400 is a scrubber
// whose recogniser has a gap, and a gap is a leak with a low-probability trigger:
// it holds up until a proxy puts a credential in a header shape nobody wrote a
// pattern for. All-or-nothing has no such failure mode. Either the string is
// clean and the consumer gets their whole message, or it is not and they get a
// marker plus the `trace_id` — which is what support actually starts from, per
// core's conventions ("`trace_id` is always present … Support starts from this
// id").
//
// TWO KINDS OF MATCH, AND WHY BOTH
//
//   1. EXACT held secrets. The class knows the one or two credential values it
//      was constructed with, so it can match them exactly. This catches a token
//      that was echoed back inside a service's own error `detail` — the one
//      place a fleet service could leak a credential by accident, and the reason
//      problem fields are redacted on the way into an exception rather than on
//      the way out of one.
//
//   2. STRUCTURAL shapes. `cafaye_…`, a JWS triple, an `Authorization` /
//      `Cookie` / `Set-Cookie` header line. This catches credentials this
//      instance never held: a `Set-Cookie: __Host-session=…` on a response this
//      class did not authenticate, or a token a caller interpolated into a
//      header before handing it over.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadDist } from './lib/dist.mjs';

const { createRedactor, REDACTED } = await loadDist('cafaye', 'redact.js');

const API_TOKEN = `cafaye_${'A'.repeat(43)}`;
const SESSION_TOKEN = 'B'.repeat(43);
const b64url = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
const A_JWT = `${b64url({ alg: 'RS256' })}.${'C'.repeat(86)}.${'D'.repeat(43)}`;

describe('the redactor', () => {
  it('names its marker, so a consumer can tell redaction from an empty message', () => {
    assert.equal(typeof REDACTED, 'string');
    assert.ok(REDACTED.length > 0);
  });

  it('leaves a clean string completely alone', () => {
    // The whole point of not over-scrubbing: a 32-hex `trace_id` is the single
    // most useful thing in a cafaye error, and a redactor that ate it would make
    // every unsupported error harder to report rather than easier.
    const trace = '0af7651916cd43dd8448eb211c80319c';
    const clean = `validation_failed (422) on /v1/users — trace ${trace}`;
    const redact = createRedactor([API_TOKEN]);
    assert.equal(redact(clean), clean);
  });

  it('removes a held credential wherever it appears in the string', () => {
    const redact = createRedactor([SESSION_TOKEN, API_TOKEN]);
    for (const text of [
      SESSION_TOKEN,
      `the token ${SESSION_TOKEN} was rejected`,
      `prefix ${API_TOKEN} suffix`,
      `both: ${SESSION_TOKEN} and ${API_TOKEN}`,
    ]) {
      assert.equal(
        redact(text),
        REDACTED,
        `the redactor left a held credential in place: ${redact(text)}`,
      );
    }
  });

  it('removes a credential shape it was never given', () => {
    // No secrets held at all: this is a response header this class never put
    // there, or a token a caller built by hand.
    const redact = createRedactor([]);
    for (const text of [
      API_TOKEN,
      `token=${API_TOKEN}`,
      A_JWT,
      'Authorization: Bearer hunter2-the-password',
      'cookie: __Host-session=abc123',
      'Set-Cookie: __Host-session=abc123; Path=/; Secure; HttpOnly',
      'authorization: bearer abcdef',
    ]) {
      assert.equal(
        redact(text),
        REDACTED,
        `the redactor passed through credential-shaped text: ${redact(text)}`,
      );
    }
  });

  it('does not redact text that merely mentions the words', () => {
    // Over-redaction is a real failure too: an exception whose message is
    // `[redacted]` instead of a diagnosis is an exception nobody can debug, and
    // a test suite that redacts everything passes while helping nobody.
    const redact = createRedactor([API_TOKEN]);
    for (const clean of [
      'the request was not authorized',
      'session cookie expired',
      'a cookie is a browser mechanism',
      'connect ECONNREFUSED 127.0.0.1:443',
      'getaddrinfo ENOTFOUND identity.example.com',
    ]) {
      assert.equal(redact(clean), clean, `the redactor mangled a clean message: ${clean}`);
    }
  });

  it('truncates, and says so, rather than silently shortening', () => {
    const redact = createRedactor([], 32);
    const long = 'x'.repeat(200);
    const out = redact(long);
    assert.ok(out.length <= 32, `expected at most 32 characters, got ${out.length}`);
    assert.notEqual(out, long);
    assert.ok(out.endsWith('…') || out.endsWith('...'), `truncation is silent: ${JSON.stringify(out)}`);
  });

  it('checks for a credential before it truncates, not after', () => {
    // The other order would be a hole: cut the string at 200 characters and a
    // token that starts at position 400 is simply not in the sample you checked.
    // (A token straddling the cut is the same argument from the other side, and
    // the structural patterns would usually catch it — the order is what makes
    // it not depend on usually.)
    const redact = createRedactor([SESSION_TOKEN], 10);
    const buried = `${'y'.repeat(500)} ${SESSION_TOKEN}`;
    assert.equal(redact(buried), REDACTED);
  });

  it('handles a non-string without throwing', () => {
    // A redactor that throws inside an error path replaces a diagnosis with a
    // second, worse error. Everything it is handed is coerced.
    const redact = createRedactor([API_TOKEN]);
    for (const value of [undefined, null, 42, {}, []]) {
      assert.equal(typeof redact(value), 'string');
    }
  });
});
