// What a customer must be able to DO through this client, stated as data, and
// measured against the two things that can answer it: the vendored document and
// the generated client.
//
// WHY THIS FILE EXISTS
//
// Every other check in this repository answers a question about the PIPELINE:
// that the vendored bytes match the index, that the committed tree matches the
// pinned generator, that a hand-edit is reverted. All of them are true today, and
// all of them would stay true if `identity` stopped describing its tenancy
// surface tomorrow. That is not a hypothetical — that already happened, and it is
// the finding: `identity` serves ten tenancy operations that appear in no
// document, and this client therefore has no method for any of them. Every check
// in the suite is green. A customer who buys "hosted identity" and tries to
// create an account gets a `TypeError` in their own code, and nothing anywhere
// in this repository says so.
//
// So this file is the missing question, asked the way a customer would ask it,
// and the answer is measured rather than asserted in prose. A number inside a
// comment cannot fail, and a measurement that cannot fail is a memory.
//
// THE TWO SIDES ARE READ SEPARATELY, AND THE DIFFERENCE MATTERS
//
// A required operation can be missing in two different ways, and they have
// different owners and different fixes:
//
//   - the document does not describe it. The fix is upstream, in the service's
//     own repository, and nothing this repository can do makes the method appear.
//   - the document describes it and the generated client does not have it. That
//     is a generator or a pipeline failure, and it IS this repository's.
//
// Collapsing the two into "missing" would produce a red that names the wrong
// owner, which is the one thing a report must not do. `evaluate` keeps them
// apart and says which is which.
//
// THE ARTIFACT IS PROBED, NOT PARSED
//
// `probeNamespace` calls every exported function of a generated namespace with a
// recording client and reads back the (method, url) each one issues. That is a
// behavioural measurement of the thing a consumer installs — no source parsing,
// no regular expression over a generator's formatting, and no way for a
// reformatting of `sdk.gen.ts` to make this file wrong. The alternative, reading
// `url:` literals out of the generated source, would answer a different question
// ("what does the text say") and would keep answering it after the text stopped
// being what runs.
//
// The wrapper is not probed, and that is not an omission.
// `test/wrapper-class.test.mjs` already asserts that `cafaye.<service>` exposes
// exactly the function exports of the generated namespace, so the namespace is
// the same set of operations one layer up.

import yaml from 'js-yaml';

import { HTTP_METHODS } from './specs.mjs';

/**
 * The HTTP methods a probe offers its recording client.
 *
 * A subset of `HTTP_METHODS`, and deliberately: `trace` and `query` are never
 * what a generated function calls, and offering them would let a namespace
 * "answer" a `TRACE /v1/widgets` requirement from something that issued a `GET`.
 * `HTTP_METHODS` is the allowlist a DOCUMENT is read with; this is the allowlist
 * the CLIENT is read with, and the two are different questions.
 */
const PROBE_METHODS = Object.freeze(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);

/**
 * The customer journey, as the operations it needs.
 *
 * ## WHAT MAKES AN OPERATION REQUIRED
 *
 * One rule, applied to every entry: **an operation is on this list if a customer
 * cannot finish buying and using the product without it.** Not "it would be
 * convenient", not "the service has it", not "it exists upstream somewhere". The
 * distinction is load-bearing, because the whole finding is the distance between
 * the second and the third, and a list built out of the third would be a copy of
 * the documents rather than a statement about the product.
 *
 * Each step therefore carries the reason in `why`, written as what breaks
 * without it, and `test/customer-capability.test.mjs` fails if any entry is
 * empty — a requirement with no stated reason is an assertion rather than a
 * reviewable claim, which is the same distinction identity's own `knownDrift`
 * draws between an exclusion and an admission.
 *
 * ## WHAT IS DELIBERATELY NOT HERE
 *
 * `GET /healthz` and `GET /readyz`. They run before auth and routing exist, no
 * customer codes against them, and identity's own document already says so by
 * documenting them. Listing them would pad the set with operations whose absence
 * breaks nothing.
 *
 * `GET /v1/accounts/{account_id}/admin/audit-log`,
 * `DELETE /v1/accounts/{account_id}/admin/invitations/{invitation_id}` and
 * `POST /v1/accounts/{account_id}/admin/invitation-revocations`. All three ARE in
 * this client, and all three require an account id, so they are currently
 * unreachable for the same reason step 2 is. They are not on the list because
 * they are not on the path to first value; they are unreachable because step 2 is
 * missing, and naming that dependency is what step 2's `why` does.
 *
 * The second half of identity's OIDC surface — `GET
 * /.well-known/oauth-authorization-server`, `GET /oidc/authorize/callback`,
 * `GET /oidc/login/{request_id}` and `POST /oidc/login/{request_id}`. The first is
 * RFC 8414 metadata that a client already gets from the OpenID document; the
 * callback is a redirect target the provider owns rather than a call a relying
 * party makes; and the `oidc/login` pair is identity's own browser UI, which a
 * customer's code does not drive. This is an exclusion list rather than a
 * complete document, and it is named here so it can be argued with — the reason
 * the fleet's own document-versus-router checks are worth reading is precisely
 * that their carve-outs are written down.
 */
export const CUSTOMER_JOURNEY = Object.freeze([
  {
    step: 1,
    title: 'A person signs up, and gets a credential',
    operations: [
      {
        service: 'identity',
        method: 'POST',
        path: '/v1/users',
        operationId: 'registerUser',
        why:
          'identity states in its own document that this is the only operation which reveals ' +
          'whether an address is already registered, and the only one that creates a user. ' +
          'Everything after this step acts on a user, so a client without it can do nothing ' +
          'at all.',
      },
      {
        service: 'identity',
        method: 'POST',
        path: '/v1/session',
        operationId: 'createSession',
        why:
          'registerUser explicitly does NOT create a session — identity says so in as many ' +
          'words in the document. Signing in is a second call, and it is the only thing that ' +
          'produces the credential every later step carries. A customer who registers and then ' +
          'has no way to sign in has an account they cannot use.',
      },
    ],
  },
  {
    step: 2,
    title: 'That person gets a tenant to work in',
    operations: [
      {
        service: 'identity',
        method: 'POST',
        path: '/v1/accounts',
        operationId: null,
        why:
          'THE OPERATION THE WHOLE PRODUCT TURNS ON. Every other `/v1/accounts/{account_id}/…` ' +
          'operation in this client is a sub-resource of an account, and this is the one that ' +
          'makes an account. With it absent the client can list an account API keys and OIDC ' +
          'clients and has no way to make the account those belong to.',
      },
      {
        service: 'identity',
        method: 'GET',
        path: '/v1/accounts',
        operationId: null,
        why:
          'The only way to recover an account id once it exists. The account switcher, the ' +
          "background job that runs on a schedule with no session, and the first render after a " +
          'page reload all need to look an id up rather than remember one, and this is the ' +
          'operation that does it.',
      },
      {
        service: 'identity',
        method: 'GET',
        path: '/v1/accounts/{account_id}',
        operationId: null,
        why:
          'Read one account. The header that shows which tenant is active, the settings screen ' +
          'and the audit trail behind it all read from this, and none of them can be built from ' +
          'the sub-resource operations that do exist.',
      },
      {
        service: 'identity',
        method: 'PATCH',
        path: '/v1/accounts/{account_id}',
        operationId: null,
        why:
          'Rename. An account whose name cannot be changed is a row rather than a tenant, and a ' +
          'customer who names their company at signup and misspells it has no way to fix it.',
      },
      {
        service: 'identity',
        method: 'DELETE',
        path: '/v1/accounts/{account_id}',
        operationId: null,
        why:
          'Close the account. It is also the only way a self-hoster answers a deletion request, ' +
          'which is a promise the platform makes rather than one this client gets to defer.',
      },
    ],
  },
  {
    step: 3,
    title: 'Somebody else joins it',
    operations: [
      {
        service: 'identity',
        method: 'POST',
        path: '/v1/accounts/{account_id}/invitations',
        operationId: null,
        why:
          'The invitation is what makes this "hosted identity for a team" rather than ' +
          '"hosted identity for one person", and it is the flow that delivers a message through ' +
          'courier. identity serves it; this client cannot issue it.',
      },
      {
        service: 'identity',
        method: 'POST',
        path: '/v1/invitations/accept',
        operationId: null,
        why:
          'The invited person is not the owner and holds no session for the account, so this is ' +
          'the only route by which an invitation ever becomes a membership. Note what this ' +
          'client already has: revokeAccountInvitation and revokeAccountInvitations, both ' +
          "documented and both generated. The surface can take an invitation away and can never " +
          'make one, and that asymmetry is invisible until somebody tries.',
      },
      {
        service: 'identity',
        method: 'GET',
        path: '/v1/accounts/{account_id}/members',
        operationId: null,
        why:
          'Render the team, and — the part that is easy to miss — know whether an address is ' +
          'already a member before inviting it, which is what turns a duplicate invitation from ' +
          'a support ticket into a checked precondition.',
      },
      {
        service: 'identity',
        method: 'PATCH',
        path: '/v1/accounts/{account_id}/members/{user_id}',
        operationId: null,
        why:
          "Change a role. Onboarding is not finished while every member is an owner, and the " +
          "authorization matrix identity already enforces per role is unreachable from a client " +
          'that can only invite.',
      },
      {
        service: 'identity',
        method: 'DELETE',
        path: '/v1/accounts/{account_id}/members/{user_id}',
        operationId: null,
        why:
          'Remove somebody. Leaving is the operation a customer needs when somebody leaves, and ' +
          'it is the one nobody thinks about until a request arrives.',
      },
    ],
  },
  {
    step: 4,
    title: 'The tenant gets a machine credential, and a sibling service can check it',
    operations: [
      {
        service: 'identity',
        method: 'POST',
        path: '/v1/accounts/{account_id}/api-keys',
        operationId: 'mintApiKey',
        why:
          'The long-lived scoped token a CI job or a backend holds. PRESENT, and it is present ' +
          'only as a method: it takes an account id in the path, so step 2 is what actually ' +
          'gates it. Naming it here is deliberate — the list is a customer path, not a complaint, ' +
          'and a check that only ever names what is broken cannot be read as a measurement.',
      },
      {
        service: 'identity',
        method: 'POST',
        path: '/v1/accounts/{account_id}/oidc-clients',
        operationId: 'registerOidcClient',
        why:
          "Register the customer's own product as a relying party. PRESENT, and gated by step 2 " +
          'in exactly the same way. What it registers is only useful once step 5 exists.',
      },
      {
        service: 'identity',
        method: 'POST',
        path: '/v1/introspections',
        operationId: 'introspectApiKey',
        why:
          "How a sibling cafaye service checks this token, and therefore the whole reason a " +
          "tenant's machine credential is usable at all. It carries no account id in its path, " +
          'so it is the one credential operation that is reachable today without step 2.',
      },
    ],
  },
  {
    step: 5,
    title: "The customer's own product signs its users in with this platform",
    operations: [
      {
        service: 'identity',
        method: 'GET',
        path: '/.well-known/openid-configuration',
        operationId: null,
        document: null,
        why:
          'OpenID Connect Discovery. Every off-the-shelf OIDC client library reads this document ' +
          'and refuses to start without it, so this is not one operation among five — it is the ' +
          'one that locates the other four. A customer integrating hosted identity for SSO reads ' +
          'it before they read anything else.',
      },
      {
        service: 'identity',
        method: 'GET',
        path: '/.well-known/jwks.json',
        operationId: null,
        document: null,
        why:
          'The keys a relying party verifies an id_token against. Without them the token is an ' +
          'opaque string, and identity mints JWKS-verified bearer JWTs precisely so it is not.',
      },
      {
        service: 'identity',
        method: 'POST',
        path: '/oidc/token',
        operationId: null,
        document: null,
        why:
          'The code-for-token exchange. This is the call that turns a browser redirect into ' +
          'something the customer backend can act on, and it is the one a server-side flow ' +
          'cannot be written without.',
      },
      {
        service: 'identity',
        method: 'GET',
        path: '/oidc/userinfo',
        operationId: null,
        document: null,
        why:
          "The signed-in user's claims. It is how a customer learns WHO signed in, which is the " +
          'entire point of signing them in.',
      },
      {
        service: 'identity',
        method: 'GET',
        path: '/oidc/authorize',
        operationId: null,
        document: null,
        why:
          'The authorization request itself. Browser-bound, so a customer can hand a user a URL — ' +
          'but building the redirect correctly means encoding state, nonce and PKCE, and that is ' +
          'the case a generated method with the parameters described is for.',
      },
    ],
  },
  {
    step: 6,
    title: 'The product sends its transactional mail',
    operations: [
      {
        service: 'courier',
        method: 'POST',
        path: '/v1/messages',
        operationId: 'sendMessage',
        why:
          'The one operation every password reset, email verification, email change and team ' +
          "invitation in the platform depends on. courier's own document says the flows were " +
          '"reachable-looking and could not complete" before it existed. This is the launch-scope ' +
          'answer for courier and it is present.',
      },
      {
        service: 'courier',
        method: 'POST',
        path: '/v1/webhook_endpoints',
        operationId: 'createWebhookEndpoint',
        why:
          'Register somewhere to be told what happened to a message. courier documents explicitly ' +
          'that it holds no delivery receipt, so a webhook is the only delivery signal a customer ' +
          'can get, and registering one is how they ask for it.',
      },
      {
        service: 'courier',
        method: 'POST',
        path: '/v1/webhook_endpoints/{id}/test',
        operationId: 'testWebhookEndpoint',
        why:
          'Send a real test delivery before trusting an endpoint with production traffic. It is ' +
          'the difference between discovering a broken webhook in staging and discovering it ' +
          'from a customer.',
      },
    ],
  },
]);

/**
 * The journey flattened to one entry per required operation.
 *
 * `document: null` means "this operation lives in a document of the service that
 * this repository does not vendor", which is a different finding from "the
 * vendored document does not describe it" and is reported as its own case by
 * `evaluate`. There is no third spelling, because the two are the two findings.
 */
export const REQUIRED_OPERATIONS = Object.freeze(
  CUSTOMER_JOURNEY.flatMap((step) =>
    step.operations.map((operation) => Object.freeze({ ...operation, step: step.step, title: step.title })),
  ),
);

/**
 * Read the (method, path) pairs a document declares, keyed as `METHOD path`.
 *
 * A real YAML parse through `measureDocument`'s sibling, `yaml.load`, and the
 * same allowlist of path-item keys — `specs.mjs` exists because "a measurement
 * computed two ways is a measurement reported two ways", and a key that is not an
 * HTTP method would make this file and the index disagree about the same document.
 *
 * The operationId comes back with each entry, because the generator names the
 * exported function after it and a document that declares an operation under a
 * name the client does not export is a finding of its own.
 */
export function documentOperations(text, { source } = {}) {
  const methods = new Set(HTTP_METHODS);
  const doc = yaml.load(text);
  if (doc === null || typeof doc !== 'object') {
    throw new Error(`${source ?? 'document'} parsed to nothing — an empty vendored copy`);
  }
  if (doc.paths === null || typeof doc.paths !== 'object') {
    throw new Error(`${source ?? 'document'} declares no \`paths\` — nothing to compare against`);
  }

  const found = new Map();
  for (const [route, item] of Object.entries(doc.paths)) {
    if (item === null || typeof item !== 'object') continue;
    for (const [key, operation] of Object.entries(item)) {
      const method = key.toLowerCase();
      if (!methods.has(method)) continue;
      if (operation === null || typeof operation !== 'object') continue;
      const label = `${method.toUpperCase()} ${route}`;
      const operationId = typeof operation.operationId === 'string' ? operation.operationId : null;
      if (found.has(label) && found.get(label) !== operationId) {
        throw new Error(
          `${source ?? 'document'}: ${label} is declared twice, as ${found.get(label)} and as ` +
            `${operationId}. A generator emits both under one path and the second is unreachable.`,
        );
      }
      found.set(label, operationId);
    }
  }
  return found;
}

/**
 * Ask a generated namespace what it can actually do.
 *
 * Every exported function is called with a recording client, and the (method,
 * url) it issues is read back. Nothing is sent: the recording client's methods
 * return an envelope and record the call, and the generated functions do no
 * validation of their own before delegating, so a call with an empty path, query
 * and body is enough to reach the transport call.
 *
 * `url` is the generator's own template, with `{account_id}` still unexpanded —
 * which is what makes this comparable with a document's path. Expanding it would
 * be a guess about a parameter value, and a comparison that had to guess would be
 * a comparison that could be wrong in a way nobody could see.
 *
 * The returned map is keyed `METHOD path` and the value is the exported name, so
 * a failure can name the method a consumer would actually type.
 */
export function probeNamespace(namespace) {
  const found = new Map();
  if (namespace === null || typeof namespace !== 'object') {
    throw new Error('probeNamespace was given something that is not a module namespace');
  }

  for (const [name, value] of Object.entries(namespace)) {
    if (typeof value !== 'function') continue;

    const calls = [];
    const client = {};
    for (const method of PROBE_METHODS) {
      client[method] = (options) => {
        calls.push({ method, url: options?.url });
        return { data: undefined, error: undefined };
      };
    }

    try {
      value({
        client,
        baseUrl: 'http://capability-probe.invalid',
        throwOnError: false,
        path: {},
        query: {},
        body: {},
      });
    } catch {
      // An export that throws before reaching the transport tells us nothing about
      // its operation, and guessing from its name would be worse than not knowing.
      // The fleet's generated operations do not do this; the guard is here so a
      // future generator change shows up as a missing operation with a reason
      // rather than as a silent zero.
      continue;
    }

    for (const { method, url } of calls) {
      if (typeof url !== 'string' || !url.startsWith('/')) continue;
      const label = `${method.toUpperCase()} ${url}`;
      if (!found.has(label)) found.set(label, name);
    }
  }

  return found;
}

/**
 * Decide, for one required operation, whether this client can do it.
 *
 * Four outcomes, and the four are the whole point:
 *
 *   `present`             the document describes it and the client has it
 *   `absent-from-client`  the document describes it and the client does NOT. This
 *                         repository's failure: a generator or pipeline problem
 *   `absent-from-document`  no vendored document describes it. identity's failure
 *   `no-vendored-document`  the operation lives in a document of the service that
 *                           this repository does not vendor at all. This
 *                           repository's structural gap, and a different one
 */
export const VERDICTS = Object.freeze({
  PRESENT: 'present',
  ABSENT_FROM_CLIENT: 'absent-from-client',
  ABSENT_FROM_DOCUMENT: 'absent-from-document',
  NO_VENDORED_DOCUMENT: 'no-vendored-document',
});

/**
 * Judge every required operation against the documents and the clients.
 *
 * `documents` and `clients` are keyed by service name and hold the two
 * measurements — what a vendored document declares, and what a generated
 * namespace issues. They are arguments rather than reads so the same function
 * judges a synthetic pair in a test, which is what makes it possible to watch this
 * file go green as well as red.
 */
export function evaluate({ journey = REQUIRED_OPERATIONS, documents, clients }) {
  return journey.map((required) => {
    const label = `${required.method} ${required.path}`;
    const document = documents?.[required.service];
    const client = clients?.[required.service];

    if (required.document === null) {
      return {
        ...required,
        label,
        verdict: VERDICTS.NO_VENDORED_DOCUMENT,
        generatedAs: client?.get(label) ?? null,
        documentOperationId: null,
      };
    }
    if (document === undefined || !document.has(label)) {
      return {
        ...required,
        label,
        verdict: VERDICTS.ABSENT_FROM_DOCUMENT,
        generatedAs: client?.get(label) ?? null,
        documentOperationId: null,
      };
    }
    if (client === undefined || !client.has(label)) {
      return {
        ...required,
        label,
        verdict: VERDICTS.ABSENT_FROM_CLIENT,
        generatedAs: null,
        documentOperationId: document.get(label),
      };
    }
    return {
      ...required,
      label,
      verdict: VERDICTS.PRESENT,
      generatedAs: client.get(label),
      documentOperationId: document.get(label),
    };
  });
}

/**
 * The owner of a verdict, in one line each.
 *
 * Split out because the report and the test failure both need it and a second
 * copy of this mapping is a second answer to "whose problem is this". The two
 * that are this repository's are named as this repository's, including the one
 * that is easiest to misattribute upward.
 */
export const VERDICT_OWNER = Object.freeze({
  [VERDICTS.PRESENT]: 'nothing to do',
  [VERDICTS.ABSENT_FROM_CLIENT]:
    'THIS REPOSITORY. The vendored document describes the operation and the committed ' +
    'generated client does not have it. That is the generator, the pipeline or the committed ' +
    'tree, and all three are here.',
  [VERDICTS.ABSENT_FROM_DOCUMENT]:
    'identity, not this repository. The operation is served and is written down in no ' +
    'document, so no amount of regenerating produces the method. Do not hand-write it into ' +
    '`src/services/`: a hand-written sibling is a lie that the next re-vendor reverts.',
  [VERDICTS.NO_VENDORED_DOCUMENT]:
    'THIS REPOSITORY, and structurally. The operations are documented — in a SECOND document ' +
    'in the same service repository — and `specs/index.json` records one `path` per service, so ' +
    'no re-vendor can ever bring them in. Closing it is a change to the index shape and to ' +
    '`openapi-ts.config.ts`, not a packet of documentation fixes.',
});

/** The verdicts that mean a customer cannot do the thing. */
export const BLOCKING_VERDICTS = Object.freeze(
  Object.values(VERDICTS).filter((v) => v !== VERDICTS.PRESENT),
);

/**
 * Render a set of findings as the block of text a failure — or a person — reads.
 *
 * Every offender in one block rather than the first, for the reason identity's
 * own document-versus-router check gives: reporting one at a time turns "run the
 * test, fix it, run it again" into a loop whose length nobody can see in
 * advance.
 *
 * `detail` picks the width, and both widths come from this one function because
 * two formatters is two renderings of the same finding and a reader who has seen
 * one of them has been told something the other would not have said.
 *
 *   'summary'  one line per operation, plus the owner once per verdict. This is
 *              what a failing `node --test` carries, and the reason the owner is
 *              grouped is that ten operations with the same owner do not need the
 *              same paragraph ten times.
 *   'full'     every operation with its reason, its name in whichever half it is
 *              present in, and the fix. This is what `npm run capability` prints.
 */
export function formatFindings(findings, { detail = 'summary' } = {}) {
  const blocking = findings.filter((f) => f.verdict !== VERDICTS.PRESENT);
  if (blocking.length === 0) return '';

  const lines = [
    `${blocking.length} required operation${blocking.length === 1 ? '' : 's'} this client ` +
      'cannot perform:',
    '',
  ];

  for (const finding of blocking) {
    lines.push(`  ${finding.verdict.padEnd(22)} ${finding.method} ${finding.path}`);
    if (finding.generatedAs !== null) {
      lines.push(`  ${' '.repeat(22)} it IS in the generated client, as \`${finding.generatedAs}\``);
    } else if (finding.documentOperationId !== null) {
      lines.push(
        `  ${' '.repeat(22)} the vendored document declares it as ` +
          `\`${finding.documentOperationId}\`, and the client does not have it`,
      );
    }
    if (detail === 'full') {
      lines.push(`  ${' '.repeat(22)} why it is on the path: ${finding.why}`);
      lines.push(`  ${' '.repeat(22)} whose it is: ${VERDICT_OWNER[finding.verdict]}`);
    }
    lines.push('');
  }

  if (detail === 'summary') {
    lines.push('whose each verdict is, once per verdict rather than once per operation:');
    for (const verdict of blockingVerdictsIn(blocking)) {
      const count = blocking.filter((f) => f.verdict === verdict).length;
      lines.push(`  ${count} x ${verdict}`);
      lines.push(`      ${VERDICT_OWNER[verdict]}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** The distinct verdicts among a set of findings, in the order they were declared. */
function blockingVerdictsIn(blockings) {
  return Object.values(VERDICTS).filter((verdict) => blockings.some((f) => f.verdict === verdict));
}

/** A one-line-per-operation table of everything, for a human to read. */
export function formatTable(findings) {
  const rows = findings.map((f) => {
    const mark = f.verdict === VERDICTS.PRESENT ? 'ok  ' : 'MISS';
    const via =
      f.verdict === VERDICTS.PRESENT
        ? `\`${f.generatedAs}\``
        : (f.generatedAs ?? f.documentOperationId ?? '—');
    return `  ${mark}  ${String(f.step)}  ${f.label.padEnd(52)} ${via}`;
  });
  const missing = findings.filter((f) => f.verdict !== VERDICTS.PRESENT).length;
  return `${rows.join('\n')}\n\n  ${findings.length - missing} of ${findings.length} required operations ` +
    `are callable through this client; ${missing} are not.\n`;
}
