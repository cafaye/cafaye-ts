#!/usr/bin/env node
//
// A real end-to-end exercise of this client against a real `identity` talking to
// a real Postgres. No mock, no fixture, no interception, and no edit to identity.
//
//   npm run e2e:identity
//
// NOT PART OF THE GATE. `bin/prime` runs `npm test` and this is not in it.
// `test/suite-is-offline.test.mjs` exists to keep sockets out of CI, and a test
// that starts a service and a database is a socket with extra steps. This is a
// tool a person runs when they want to know whether the generated client actually
// works, and it is here rather than in a scratch directory because the next
// person who asks that question should not have to rebuild it.
//
// `.mjs` AND NOT `.ts`, which is a choice with a cost worth naming. The first
// version of this script passed `{ body: { key } }` to `introspectApiKey`, and
// identity answered 422 — "the request body has a field this endpoint does not
// accept" — because the generated `IntrospectRequest` types the field as `token`.
// The compiler would have caught it. This file is plain JavaScript so it runs with
// nothing but `node`, and that is exactly why it did not. The lesson is not "write
// it in TypeScript", because the gate's floor is a test suite and this is not in
// it; it is that the type layer is doing real work and a script written against
// these types should be written in them.
//
// WHAT IT EXERCISES, AND WHY THESE STEPS
//
// 1. the operations the freshly vendored document produced, bound on the class
// 2. registerUser -> createSession -> getCurrentUser, a real round trip
// 3. the credential discriminator against BOTH real credential shapes identity
//    mints, because a classifier tested only on hand-made strings is a classifier
//    tested on nothing
// 4. mintApiKey / introspectApiKey / revokeApiKey — three operations that did not
//    exist in the document cafaye-ts-01 vendored, on the surface whose auth model
//    is the reason the hand-written half exists
// 5. identity's own RFC 9457 error body, mapped into this client's exception
//    hierarchy
//
// THE ONE THING IT READS OUT OF BAND, AND WHY
//
// The account id for the API-key steps comes from `psql`, not from an HTTP call.
//
// `identity`'s router serves `GET /v1/accounts` and `POST /v1/accounts` — its own
// `internal/httpapi/accounts.go` documents both, and its own integration tests
// call the GET — and `openapi/v1.yaml` describes neither. So the generated client
// cannot name the account a registration created, and there is no HTTP path in
// this client's surface that can.
//
// That is a real drift finding about identity's document, not a workaround
// invented to make this script pass, and it is why the step is marked as reading
// out of band rather than quietly skipped. Closing it means adding the two routes
// to identity's document and re-vendoring; it is not closed here, because this
// repository does not own identity's document.
//
// NO DEPENDENCIES. `psql` is invoked as a subprocess. `dependencies` is `{}` in
// package.json and MD6 requires it to stay `{}`, and a Postgres driver is
// exactly the kind of thing that would end that — for the benefit of a script
// that is not shipped and not gated.
//
// WHAT IT NEEDS
//
//   CAFAYE_IDENTITY_URL   default http://127.0.0.1:18081
//   CAFAYE_IDENTITY_PG    default postgresql://…@127.0.0.1:5432/cafaye_ts_e2e
//   psql on PATH
//
// The report in REPORT-cafaye-ts-01b.md carries the exact five commands that
// bring identity up against an already-running Postgres, migrations included.

import { execFileSync } from 'node:child_process';

import { Cafaye, CafayeProblemError, CafayeUnauthenticatedError } from '../dist/index.js';

const BASE = process.env.CAFAYE_IDENTITY_URL ?? 'http://127.0.0.1:18081';
const PGURL =
  process.env.CAFAYE_IDENTITY_PG ?? 'postgresql://cafaye_ts:cafaye_ts@127.0.0.1:5432/cafaye_ts_e2e';
const STAMP = Date.now();
const EMAIL = `cafaye-ts-e2e-${STAMP}@example.com`;
const PASSWORD = 'correct-horse-battery-staple';
const API_TOKEN_PREFIX = 'cafaye_';

// All six base URLs, not one. `Cafaye` resolves every service in its constructor
// and throws naming the one it could not resolve — a partial `baseUrl` record is a
// construction-time error rather than a surprise on the fifth call — so a harness
// that names only `identity` cannot construct the client at all. That is the
// designed behaviour and it is worth seeing once; pointing the other five at the
// same address here is harmless because this script never calls them.
const cafaye = new Cafaye({
  baseUrl: {
    identity: BASE,
    billing: BASE,
    muse: BASE,
    darkroom: BASE,
    pantry: BASE,
    courier: BASE,
  },
  timeoutMs: 10_000,
});

let failures = 0;

function check(what, ok, detail) {
  process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail === undefined ? '' : `  (${detail})`}\n`);
  if (!ok) failures += 1;
}

function step(title) {
  process.stdout.write(`\n${title}\n`);
}

/**
 * One value out of Postgres, as text. The harness's only database access.
 *
 * Interpolated rather than parameterised, and the reason is worth a line because
 * it is the wrong thing to do in application code: the only value that reaches
 * this string is `registered.id`, which is a UUID this client just read back out
 * of identity's own response, and the query is not user input from anywhere. A
 * `-v` bind would need the value in the connection string or a second round trip
 * for one call, and this is a harness rather than a service. It is written this
 * way so nobody copies the pattern into a handler.
 */
function psqlScalar(sql) {
  return execFileSync(
    'psql',
    [PGURL, '--quiet', '--tuples-only', '--no-align', '--command', sql],
    { encoding: 'utf8', env: { ...process.env, PGCONNECT_TIMEOUT: '5' } },
  ).trim();
}

// ------------------------------------------------------------ 1. the surface

step('1. the namespace the freshly vendored document produced');
const ops = Object.keys(cafaye.identity).filter((k) => typeof cafaye.identity[k] === 'function');
process.stdout.write(`   ${ops.length} bound operations\n`);
for (const name of ['registerUser', 'createSession', 'getCurrentUser', 'mintApiKey', 'listApiKeys', 'revokeApiKey', 'introspectApiKey']) {
  check(`cafaye.identity.${name} is bound`, ops.includes(name));
}
check('and there are 31 of them, which is what identity 1.5.0 declares', ops.length === 31, `${ops.length}`);

// ------------------------------------------- 2. registration and a real session

step('2. register and sign in, through the generated transport');
const registered = await cafaye.identity.registerUser({ body: { email: EMAIL, password: PASSWORD } });
check('registerUser returned a user identity really inserted', typeof registered.id === 'string', `id ${registered.id}`);
check('with the address normalised the way identity documents', registered.email === EMAIL, registered.email);

const session = await cafaye.identity.createSession({ body: { email: EMAIL, password: PASSWORD } });
const token = session.token;
check('createSession returned a session token', typeof token === 'string', `${String(token).slice(0, 12)}…`);
check('and it is NOT cafaye_-prefixed, so it is the session shape', !String(token).startsWith(API_TOKEN_PREFIX));

// ------------------------------------------------- 3. the discriminator, live

step('3. the credential discriminator, against both shapes identity mints');
cafaye.setCredentials({ token });
check(
  'a session token is classified as a session, so it may also travel as the cookie identity accepts',
  cafaye.credentialKind === 'session',
  String(cafaye.credentialKind),
);

const me = await cafaye.identity.getCurrentUser();
check('getCurrentUser resolved that session to a real row', me.email === EMAIL, me.email);

// ---------------------------------------------- 4. the api-key surface, new

step('4. mintApiKey / introspectApiKey / revokeApiKey — none of these existed in the document cafaye-ts-01 vendored');
// Read out of band, and the reason is in this file's header: identity serves
// GET /v1/accounts and its document describes neither that nor POST /v1/accounts,
// so there is no HTTP path on this client's surface that can name the account a
// registration created.
const account = psqlScalar(
  `select a.id from accounts a join account_users au on au.account_id = a.id where au.user_id = '${registered.id}' and a.personal limit 1`,
);
check('the registration created the personal account it documents', Boolean(account), account || 'none');

const minted = await cafaye.identity.mintApiKey({
  path: { account_id: account },
  body: { name: 'cafaye-ts e2e', scopes: ['accounts:read'] },
});
const key = minted.token;
check('mintApiKey returned a credential', typeof key === 'string');
check(
  `it carries identity's own \`${API_TOKEN_PREFIX}\` prefix, the discriminator src/cafaye/credentials.ts reads`,
  typeof key === 'string' && key.startsWith(API_TOKEN_PREFIX),
  `${String(key).slice(0, 10)}… of ${String(key).length} chars`,
);
check('and 43 characters after the prefix, which is identity\'s documented shape', String(key).length === API_TOKEN_PREFIX.length + 43);

// The two surfaces a credential can be on, and the discriminator is what keeps
// them apart. Three of this script's first assumptions were wrong and identity
// was right each time, which is the most useful thing an end-to-end run can
// report about a client it is testing:
//
//   * a scoped token on /v1/me            -> 401, documented and intended
//   * a scoped token on the api-key routes -> 403, deliberate: a token cannot
//     manage tokens, and identity's own authz_matrix_test.go says so in words
//
// What the classifier buys is that a session ALSO goes out as the cookie identity
// accepts, and a scoped token never does, with no branch at the call site.
cafaye.setCredentials({ token: key });
check('the client classifies it as an apiToken, not a session', cafaye.credentialKind === 'apiToken', String(cafaye.credentialKind));

const live = await cafaye.identity.introspectApiKey({ body: { token: key } });
check('introspectApiKey resolves it', live.active === true, `active=${live.active}`);
check('with the scope it was minted with', live.scopes?.includes('accounts:read') === true, JSON.stringify(live.scopes));
check('bound to the account it was minted against', live.account_id === account, String(live.account_id));
check('and MD7\'s ambiguity is visible here: identity emits both claim names', typeof live.scope === 'string' && typeof live.scopes === 'string', `scope=${JSON.stringify(live.scope)} scopes=${JSON.stringify(live.scopes)}`);

let onSessionRoute = null;
try {
  await cafaye.identity.getCurrentUser();
} catch (error) {
  onSessionRoute = error;
}

check(
  'a scoped token is REFUSED on the session route with the 401 identity documents',
  onSessionRoute?.status === 401,
  `status=${onSessionRoute?.status} code=${onSessionRoute?.code}`,
);

let onKeyRoute = null;
try {
  await cafaye.identity.listApiKeys({ path: { account_id: account } });
} catch (error) {
  onKeyRoute = error;
}
check(
  'and REFUSED with 403 on the api-key routes themselves, which is deliberate: a token cannot manage tokens',
  onKeyRoute?.status === 403,
  `status=${onKeyRoute?.status} detail="${onKeyRoute?.detail}"`,
);

// Back to the session for the management routes. identity's `authz_matrix_test.go`
// is explicit that this surface is owner-only and session-shaped, and the 403
// above is the designed answer rather than a gap.
cafaye.setCredentials({ token });
// An ARRAY, not `{keys: [...]}`, and `jti` rather than `key_id` on the
// introspection document — both read out of the vendored document's schemas, and
// both are the kind of thing a hand-written caller guesses wrong.
const listed = await cafaye.identity.listApiKeys({ path: { account_id: account } });
check('listApiKeys returns an array, as its document declares', Array.isArray(listed));
check('holding exactly the one key that was minted', listed.length === 1, `${listed.length}`);
check('with the name it was minted under', listed[0]?.name === 'cafaye-ts e2e', listed[0]?.name);
check('and never the token itself, which identity shows once', !JSON.stringify(listed).includes(key));

await cafaye.identity.revokeApiKey({ path: { account_id: account, key_id: live.jti } });
const dead = await cafaye.identity.introspectApiKey({ body: { token: key } });
check('after revokeApiKey the credential no longer resolves', dead.active === false, `active=${dead.active}`);

// Still LISTED, and that is right rather than surprising: identity's
// `ListForAccount` does not filter on `revoked_at`, and the reason is in the
// document — "The row is kept, not deleted. 'Was this token revoked, or was it
// always broken?' is a support question and a deleted row answers it for nobody."
// What makes the list safe to render is that the row carries `revoked_at`, so the
// revoked one is distinguishable from the live one.
const afterRevoke = await cafaye.identity.listApiKeys({ path: { account_id: account } });
check('the revoked row is kept and still listed', afterRevoke.length === 1, `${afterRevoke.length}`);
check(
  'and it carries the revoked_at that tells a live key from a dead one',
  typeof afterRevoke[0]?.revoked_at === 'string',
  String(afterRevoke[0]?.revoked_at),
);

// The revoked credential is refused on the session route, proved earlier with the
// credential still live and restated here because it is the property that matters
// and revocation is what makes it permanent: switch back to the machine
// credential and the same call that answered 401 still answers 401.
cafaye.setCredentials({ token: key });
let revokedRefused = null;
try {
  await cafaye.identity.getCurrentUser();
} catch (error) {
  revokedRefused = error;
}
check(
  'and the revoked credential is refused on the session route exactly as the live one was',
  revokedRefused?.status === 401,
  `${revokedRefused?.constructor?.name} status=${revokedRefused?.status} code=${revokedRefused?.code}`,
);

// ------------------------------------------------- 5. the RFC 9457 mapping

step("5. identity's own problem document, through this client's exception hierarchy");
cafaye.setCredentials({ token });

let wrong = null;
try {
  await cafaye.identity.createSession({ body: { email: EMAIL, password: 'wrong' } });
} catch (error) {
  wrong = error;
}
check('a wrong password threw rather than returning an envelope', wrong !== null);
check('and it is a typed CafayeUnauthenticatedError, not a bare Problem object', wrong instanceof CafayeUnauthenticatedError, wrong?.constructor?.name);
check("carrying identity's own `code`", wrong?.code === 'unauthorized', String(wrong?.code));
check('with a status a caller can branch on', wrong?.status === 401, String(wrong?.status));
check('and a trace_id identity can be looked up by', typeof wrong?.traceId === 'string', String(wrong?.traceId));
check(
  'and no credential anywhere in the message or the stringified error',
  !JSON.stringify({ m: wrong?.message, s: String(wrong) }).includes(String(token)),
);

step('6. no credential at all');
cafaye.setCredentials(null);
check('the class reports no credential kind', cafaye.credentialKind === null);

let anonymous = null;
try {
  await cafaye.identity.getCurrentUser();
} catch (error) {
  anonymous = error;
}
check('an unauthenticated call is a typed Cafaye error, not a crash', anonymous instanceof CafayeProblemError, `${anonymous?.constructor?.name} status=${anonymous?.status}`);

process.stdout.write(failures === 0 ? '\ne2e: every step passed\n' : `\ne2e: ${failures} step(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);