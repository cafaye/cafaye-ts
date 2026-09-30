// Which credential is this, and what may be done with it?
//
// The fleet has two auth MODELS — identity mints an opaque credential and
// everything else verifies a JWKS-signed JWT — and three credential SHAPES, and
// the difference between the two counts is the whole reason this class exists.
// MD6 says so: "The specs already contain two different auth models … A
// generated client cannot hide that, and neither can a naive unified one; a
// single hand-written `Cafaye` class owns credential handling."
//
// The three shapes, and where each shape is stated in the fleet rather than
// invented here:
//
//   apiToken  `cafaye_` + 43 base64url characters. identity's
//             `internal/apikeys/apikeys.go` builds it as
//             `Prefix + base64.RawURLEncoding.EncodeToString(32 random bytes)`,
//             and `internal/httpapi/apikeys.go` says the reason the prefix exists
//             at all: "THE PREFIX IS THE DISCRIMINATOR … no presented value of the
//             wrong shape ever reaches the api_keys table." This package uses the
//             same discriminator, for the same reason and with the same prefix.
//
//   session   43 base64url characters, no prefix. identity's
//             `internal/sessions/token.go` is `base64.RawURLEncoding` over the
//             same 32 bytes, and identity's document says the same value is
//             returned twice: as a `__Host-session` cookie and as `token` in the
//             body, naming one session on two surfaces.
//
//   jwt       three base64url segments whose first decodes to a JWS header.
//             core's `docs/openapi-conventions.md`: "Bearer JWTs only:
//             `Authorization: Bearer <jwt>` … Required claims: `iss`, `aud`, `sub`,
//             `exp`, `iat`, `jti`, plus `account_id` and `scopes`."
//
// WHY THE JWT IS ITS OWN CASE AND NOT FALLEN THROUGH TO "session"
// A session is the one shape allowed to travel in a `Cookie` header. If a JWT
// were classified as a session, the class would put a bearer JWT into
// `Cookie: __Host-session=<jwt>` and hand a service-to-service credential to the
// browser-cookie surface, which is the dangerous direction to be wrong in. The
// asymmetry is deliberate: a misclassified session loses a cookie it did not need
// (the bearer header is still there and identity accepts either), while a
// misclassified JWT leaks a fleet-wide credential into a header that a browser
// will not let a script set and a proxy will happily log.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadDist } from './lib/dist.mjs';

const { classifyCredential, API_TOKEN_PREFIX, SESSION_COOKIE_NAME } = await loadDist(
  'cafaye',
  'credentials.js',
);

/** identity's own shapes, built the way identity builds them. */
const API_TOKEN = `${API_TOKEN_PREFIX}${'A'.repeat(43)}`;
const SESSION_TOKEN = 'B'.repeat(43);

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const A_JWT = `${b64url({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${'C'.repeat(86)}.${'D'.repeat(43)}`;

describe('the credential discriminator', () => {
  it('names the constants the fleet uses rather than inventing its own', () => {
    // These two strings are a contract with identity, not a convention of ours.
    // `__Host-session` is identity's `internal/httpapi/auth.go` constant, and the
    // `__Host-` prefix is a browser-enforced contract: such a cookie is accepted
    // only if it is Secure, has Path=/ and carries no Domain. Getting the name
    // wrong produces a request that looks authenticated and is not.
    assert.equal(API_TOKEN_PREFIX, 'cafaye_');
    assert.equal(SESSION_COOKIE_NAME, '__Host-session');
  });

  it('reads the cafaye_ prefix as a scoped API token', () => {
    assert.equal(classifyCredential(API_TOKEN), 'apiToken');
  });

  it('reads an unprefixed 43-character opaque value as a session token', () => {
    assert.equal(classifyCredential(SESSION_TOKEN), 'session');
  });

  it('reads a three-segment JWS as a JWT, not as a session token', () => {
    assert.equal(classifyCredential(A_JWT), 'jwt');
  });

  it('does not mistake a session token for a JWT', () => {
    // The obvious wrong implementation is "three segments means JWT", checked
    // from either end. identity's session token has no dots at all, so that one
    // is easy — the case that bites is a base64url value that happens to contain
    // dots, and a JWT-looking string whose header is not a JWS header.
    assert.equal(classifyCredential('one.two.three'), 'session');
    assert.equal(classifyCredential('not-base64!.and.more'), 'session');
    // Three segments, but the first is not base64url-decodable JSON: a shape
    // match alone is not enough, so this stays a session rather than becoming a
    // JWT on the strength of punctuation.
    assert.equal(classifyCredential('aaaa.bbbb.cccc'), 'session');
  });

  it('treats an unsecured JWS (an empty signature) as a JWT rather than a session', () => {
    // core rejects `alg: none` outright, so identity will never mint one. But the
    // classification is about the SHAPE of the value in the consumer's hand, and
    // a value shaped like a JWS is handled like one — the server rejecting it is
    // the server's documented job, not this class's.
    const unsecured = `${b64url({ alg: 'none' })}.${'C'.repeat(86)}.`;
    assert.equal(classifyCredential(unsecured), 'jwt');
  });

  it('refuses a credential that could break a header, before any request is made', () => {
    // Header injection. `Authorization: Bearer a\r\nX-Admin: true` is a
    // request for a capability the caller does not have, and the only reason it
    // does not work is that undici validates header values — a protection this
    // package does not own and cannot rely on across runtimes. A value with a
    // CR, an LF, a NUL, another control character, or nothing but whitespace is
    // a configuration mistake, and a configuration mistake is reported as one at
    // construction rather than as a 401 from a service three hours later.
    for (const bad of [
      '',
      '   ',
      '\t',
      'abc\r def',
      'abc\ndef',
      'abc\u0000def',
      'abc\u007fdef',
      'cafaye_abc ',
    ]) {
      assert.throws(
        () => classifyCredential(bad),
        (error) => {
          assert.match(error.name, /^Cafaye/);
          assert.equal(error.kind, 'configuration');
          // The offending value must not be quoted back in the message: a
          // credential that reached an exception message has leaked, and this
          // test is one of the places that proves it does not.
          assert.ok(
            !error.message.includes(bad.trim()) || bad.trim() === '',
            `the configuration error quoted the rejected credential: ${error.message}`,
          );
          return true;
        },
        `classifyCredential accepted ${JSON.stringify(bad)}`,
      );
    }
  });

  it('accepts every shape the fleet actually mints', () => {
    for (const value of [API_TOKEN, SESSION_TOKEN, A_JWT]) {
      assert.ok(
        ['apiToken', 'jwt', 'session'].includes(classifyCredential(value)),
        `classifyCredential rejected a credential identity can mint: ${classifyCredential(value)}`,
      );
    }
  });
});
