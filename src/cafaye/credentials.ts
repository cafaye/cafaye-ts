// Which credential is this, and where may it go?
//
// MD6 put this in one sentence and the sentence is the reason this packet
// exists: "The specs already contain two different auth models — identity issues
// an opaque server-side session token … while everything else uses a JWKS-
// verified bearer JWT. A generated client cannot hide that, and neither can a
// naive unified one; a single hand-written `Cafaye` class owns credential
// handling."
//
// Two auth models, three credential SHAPES. The extra shape is identity-08's
// scoped API token, which MD6's sentence predates: `cafaye_` plus 32 random
// bytes, opaque like a session token, revocable, carrying a scope set. Treating
// it as "some other token" is how a client ends up pasting it into a logout call
// — which identity-08's own document calls out, because `DELETE /v1/session`
// answers 403 to a scoped token and used to answer 204.
//
// THE PREFIX IS THE DISCRIMINATOR, and identity already decided that.
//
// identity's `internal/httpapi/apikeys.go` says it outright: "THE PREFIX IS THE
// DISCRIMINATOR, and that is the second thing the `cafaye_` prefix buys. A
// request arrives with either a session token or an api key, and the two live in
// different tables with different lifetimes and different revocation stories.
// Something has to decide which one this is before the database is asked, and
// the prefix decides it without a query."
//
// So this class reads the same prefix, for the same reason. That is a decision
// to follow identity rather than to invent a parallel scheme, and it is why
// `API_TOKEN_PREFIX` below is a constant that can be checked against identity's
// `apikeys.Prefix` rather than a string literal buried in a switch.
//
// WHY THE THREE-WAY SPLIT AND NOT TWO
//
// A session token is the only shape that is allowed to travel in a cookie.
// identity's document says so ("As a `__Host-session` cookie, for a browser. The
// cookie is `Secure`, `HttpOnly`, `SameSite=Lax` and `Path=/`, with no `Domain`")
// and so does core ("No cookies for API traffic; browser sessions use … cookies
// and a CSRF token, and those are a *different* surface, not an API exception").
//
// A JWT is not a session, and if the classifier cannot tell them apart it will
// eventually put a fleet-wide service credential into a `Cookie` header, which a
// browser refuses to let a script set and a reverse proxy is happy to log. The
// asymmetry decides the fallback: a session misread as a JWT loses a cookie it
// did not strictly need — the bearer header is still attached and identity
// documents that it prefers the header when both are present — while a JWT
// misread as a session publishes itself onto the wrong surface.

import { CafayeConfigurationError } from './errors.js';

/** identity's `apikeys.Prefix`. Read as the discriminator, exactly as identity does. */
export const API_TOKEN_PREFIX = 'cafaye_';

/**
 * identity's `httpapi.SessionCookieName`. The `__Host-` prefix is not cosmetic:
 * it is a browser-enforced contract requiring Secure, Path=/ and no Domain, and
 * a request that names the cookie wrongly is a request that looks authenticated
 * and is not.
 */
export const SESSION_COOKIE_NAME = '__Host-session';

/** What a credential is, which decides where it may be sent. */
export type CredentialKind = 'apiToken' | 'jwt' | 'session';

/**
 * Characters that cannot appear in a credential.
 *
 * This is a safety floor, not a definition. The point is not to enumerate the
 * alphabet — which would break the first time the fleet mints something new —
 * but to refuse anything that could terminate a header line or a cookie
 * attribute. CR, LF and NUL are header injection; the other C0 controls, DEL and
 * the space have no legitimate use in any of the three shapes, and a credential
 * containing one is a configuration mistake whatever produced it. Reporting that
 * at construction is worth more than a 401 from a service three hours later.
 */
const FORBIDDEN_IN_CREDENTIAL = /[\u0000-\u0020\u007f]/;

/** A JWS compact serialization: three dot-separated base64url segments. */
const JWS_COMPACT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/**
 * Is this a JWS compact serialization, and does its header say so?
 *
 * The shape is necessary and not sufficient, so the header segment is decoded
 * and parsed. That costs one `atob` and one `JSON.parse` per classification —
 * once per credential, not per request — and it is what keeps `one.two.three`,
 * which is three segments and not a JWT, out of the JWT branch. A base64url
 * value that happens to contain dots is a session token, and a session token
 * that gets the cookie is the safe direction to be wrong in.
 */
function isJwt(token: string): boolean {
  if (!JWS_COMPACT.test(token)) return false;
  // The default is unreachable — JWS_COMPACT guarantees a dot, so a split always
  // has three parts — but `noUncheckedIndexedAccess` cannot see that, and a
  // non-null assertion here would be a claim the compiler is right to doubt.
  const [encodedHeader = ''] = token.split('.');
  try {
    const header: unknown = JSON.parse(
      atob(encodedHeader.replace(/-/g, '+').replace(/_/g, '/')),
    );
    return (
      typeof header === 'object' &&
      header !== null &&
      typeof (header as { alg?: unknown }).alg === 'string'
    );
  } catch {
    // Not base64, not JSON, or not an object: whatever it is, it is not a JWS.
    return false;
  }
}

/**
 * Classify a credential, and refuse one that could break a header.
 *
 * @throws {CafayeConfigurationError} for an empty, blank or control-character
 * value. The offending value is never quoted back in the message: a credential
 * that reached an exception message has leaked, and this is one of the places
 * that has to be true for that not to have happened.
 */
export function classifyCredential(token: string): CredentialKind {
  if (typeof token !== 'string' || token.length === 0 || FORBIDDEN_IN_CREDENTIAL.test(token)) {
    throw new CafayeConfigurationError(
      'A cafaye credential must be a non-empty string containing no control characters or ' +
        'spaces. Refusing it here rather than sending it: a value carrying CR or LF would be a ' +
        'header-injection attempt, and a blank one is a configuration mistake that would ' +
        'otherwise surface as a 401 from a service some hours later.',
    );
  }
  if (token.startsWith(API_TOKEN_PREFIX)) return 'apiToken';
  if (isJwt(token)) return 'jwt';
  return 'session';
}

/**
 * Attach a credential to a request's headers, in the one place that does it.
 *
 * Two rules, both of them load-bearing:
 *
 *   - A session contributes BOTH forms, and that is not redundancy. identity's
 *     document states how it resolves a request carrying both — "An
 *     `Authorization: Bearer` header is preferred over the cookie when both are
 *     present, because a client holding both has said which one it means" — so
 *     sending both is unambiguous by the server's own rule, and it is what lets a
 *     single credential work against identity (which accepts the cookie) and
 *     against the other five (which core says take a bearer and nothing else)
 *     with no choice at the call site. That is the requirement; the tie-break is
 *     the server's.
 *
 *   - An existing header is never overwritten. The generated client applies the
 *     same rule to the same problem (`checkForExistence` in its `utils.gen.ts`),
 *     and matching it means a caller who passes their own `Authorization` per
 *     call gets theirs, rather than a surprise in which of two values wins.
 */
export function attachCredential(headers: Headers, token: string | null | undefined): void {
  if (token === null || token === undefined) return;

  const kind = classifyCredential(token);
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  if (kind === 'session' && !headers.has('Cookie')) {
    headers.set('Cookie', `${SESSION_COOKIE_NAME}=${token}`);
  }
}
