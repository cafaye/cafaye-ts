// The check `bin/prime` runs and the report quotes: can a customer actually use
// the product through this client?
//
// WHY THIS FILE IS RED TODAY, AND WHY THAT IS THE POINT
//
// Two of the seven tests below fail on this tree, and they are supposed to. A
// customer who installs this package to buy "hosted identity + courier" cannot
// create an account, cannot invite anybody, cannot accept an invitation, and
// cannot integrate this platform's sign-in into their own product. Every other
// check in this suite is green, and every one of them would stay green if that
// were true or false: they ask whether the vendored bytes match the index and
// whether the committed tree matches the pinned generator, and both of those are
// properties of the PIPELINE rather than of the PRODUCT. The pipeline is in good
// order. The product it is faithfully describing cannot be bought.
//
// So this file measures the thing the pipeline is for. A check that cannot fail
// is a memory, and a memory about a launch is worth very little at 3am.
//
// THE FIVE THAT PASS ARE NOT DECORATION
//
// A red file that only ever proves things are broken teaches a reader to ignore
// it, and the two controls below are what stop that happening:
//
//   - the probe is shown finding a synthetic operation, and shown NOT finding a
//     synthetic one. A checker that has only ever been seen red might be red
//     because it is a match-all, and a match-all is not a measurement.
//   - every operation the six documents declare is shown to be reachable through
//     the generated client. That is what makes the "absent-from-client" verdict
//     meaningful: on this tree it never fires, so a red of that kind would mean
//     the generator broke rather than that the documents are thin.
//
// THE FAILURES POINT AT A DOCUMENT, NOT AT A METHOD
//
// Each failure names the (method, path) and the verdict, and the verdicts are
// kept apart on purpose. `absent-from-document` is identity's to fix: the
// operation is served and is written down nowhere, so no amount of regenerating
// produces a method, and hand-writing one into `src/services/` would be a lie
// that the next re-vendor reverts. `no-vendored-document` is this repository's,
// and structurally: the operations are documented — in a SECOND document in
// identity's repository — and `specs/index.json` records one `path` per service,
// so no re-vendor can ever bring them in. Collapsing the two would produce a red
// that misattributes half of itself.
//
// HOW TO MAKE IT GREEN, AND WHY IT IS NOT THIS PACKET'S MOVE
//
//   the ten tenancy operations  identity adds them to `openapi/v1.yaml` with
//                             operationIds and schemas, re-vendors, regenerates.
//                             Its own `internal/httpapi/openapi_drift_test.go`
//                             already holds all ten in a `knownDrift` map whose
//                             own comment says the list "cannot grow and cannot
//                             be emptied" — closing it is D1, and D1 is a
//                             decision in identity's DECISIONS.md.
//
//   the five OIDC operations     this repository. The fix is a shape change:
//                             `specs/index.json` keyed by document rather than
//                             by service, and `openapi-ts.config.ts` giving each
//                             document its own output directory, because two
//                             documents for one service cannot share
//                             `src/services/identity/`. That is an architectural
//                             change to how this package is laid out, and it
//                             wants its own packet and its own reviewed diff.
//
// `npm run capability` prints the same finding as a list, for a person rather
// than for a gate log.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  CUSTOMER_JOURNEY,
  REQUIRED_OPERATIONS,
  VERDICTS,
  documentOperations,
  evaluate,
  formatFindings,
  probeNamespace,
} from '../scripts/lib/capability.mjs';
import { loadDist } from '../scripts/lib/dist.mjs';
import { readIndex, specPathFor } from '../scripts/lib/specs.mjs';

const index = await readIndex();
const byService = new Map(index.services.map((s) => [s.service, s]));

/** What each vendored document declares, keyed `METHOD path`. */
const documents = {};
/** What each generated client issues, keyed `METHOD path`. */
const clients = {};

for (const entry of index.services) {
  const bytes = await readFile(specPathFor(entry));
  documents[entry.service] = documentOperations(bytes.toString('utf8'), {
    source: `${entry.service} (${entry.spec})`,
  });
  clients[entry.service] = probeNamespace(await loadDist('services', entry.service, 'index.js'));
}

const findings = evaluate({ documents, clients });
const forStep = (step) => findings.filter((f) => f.step === step);
const missingIn = (step) => forStep(step).filter((f) => f.verdict !== VERDICTS.PRESENT);

/**
 * A namespace whose one exported function issues one operation.
 *
 * Two details are copied from a generated function because the probe measures
 * through them: it delegates to `options.client` rather than to a client of its
 * own, and it supplies `url` in the object it hands the client rather than
 * expecting to find one on `options`. A fixture that kept its own client, or
 * that forwarded `options` unchanged, would fail the control below for a reason
 * that has nothing to do with the probe — which is exactly what happened the
 * first time this was written, and is the reason the shape is spelled out here.
 */
function namespaceIssuing(method, url, name = 'theOperation') {
  const operation = (options) => options.client[method.toLowerCase()]({ ...options, url });
  return { [name]: operation };
}

describe('the customer path, as a stated requirement', () => {
  it('names every required operation, with a service, a method, a path and a reason', () => {
    // A requirement with no stated reason is an assertion rather than a
    // reviewable claim. That distinction is identity's own — an entry in
    // `knownDrift` with a blank reason fails its drift test for exactly this
    // reason — and it is the reason a reader can argue with a line here instead
    // of having to take it on faith.
    for (const required of REQUIRED_OPERATIONS) {
      const label = `${required.method} ${required.path}`;
      assert.ok(required.service, `${label}: no service`);
      assert.ok(
        byService.has(required.service),
        `${label}: service ${required.service} is not in specs/index.json`,
      );
      assert.match(
        required.method,
        /^(GET|PUT|POST|DELETE|PATCH|HEAD|OPTIONS)$/,
        `${label}: method is not an HTTP method`,
      );
      assert.match(required.path, /^\//, `${label}: path is not absolute`);
      assert.ok(
        typeof required.why === 'string' && required.why.trim().length > 40,
        `${label}: the reason it is on the path is missing or too short to be one. Every entry ` +
          'has to say what breaks without it, or it is a preference rather than a requirement.',
      );
    }

    // Steps are numbered from one and do not skip, because a gap in the sequence
    // is how "step 3" ends up meaning two different things in two documents.
    const steps = CUSTOMER_JOURNEY.map((s) => s.step);
    assert.deepEqual(
      steps,
      Array.from({ length: steps.length }, (_, i) => i + 1),
      'the journey steps are not 1..n in order',
    );
    for (const step of CUSTOMER_JOURNEY) {
      assert.ok(step.operations.length > 0, `step ${step.step} requires nothing`);
      assert.ok(step.title.trim().length > 0, `step ${step.step} has no title`);
    }

    // The two steps that are the finding are named in the data, not inferred by a
    // test, so that `npm run capability` and this file cannot disagree about
    // which operations belong to which finding.
    const labelled = new Set(REQUIRED_OPERATIONS.map((r) => `${r.step}:${r.method} ${r.path}`));
    assert.equal(labelled.size, REQUIRED_OPERATIONS.length, 'the required set has a duplicate entry');
  });

  it('the probe finds an operation that is there', () => {
    // THE CONTROL, and it is the first test in the file for the same reason case 0
    // is the first case in `test/gate_self_test.sh`: thirteen reds against a
    // repository that was already red prove nothing. This one shows the
    // measurement is capable of the answer `present`, so the reds below mean
    // something.
    const probed = probeNamespace(namespaceIssuing('POST', '/v1/accounts', 'createAccount'));
    const judged = evaluate({
      journey: [
        {
          service: 'identity',
          method: 'POST',
          path: '/v1/accounts',
          operationId: 'createAccount',
          why: 'a synthetic requirement, so that the control measures the probe and nothing else',
        },
      ],
      documents: { identity: new Map([['POST /v1/accounts', 'createAccount']]) },
      clients: { identity: probed },
    });

    assert.equal(judged[0].verdict, VERDICTS.PRESENT);
    assert.equal(judged[0].generatedAs, 'createAccount');
  });

  it('the probe is not a match-all: it rejects a wrong method and a wrong path', () => {
    // A checker that has only ever been seen failing might be failing because it
    // matches everything. These two are the other direction, and they are what
    // makes the reds above a measurement rather than a constant.
    const probed = probeNamespace(namespaceIssuing('POST', '/v1/accounts', 'createAccount'));

    for (const wrong of [
      { method: 'GET', path: '/v1/accounts', expected: VERDICTS.ABSENT_FROM_CLIENT },
      { method: 'POST', path: '/v1/accounts/{account_id}', expected: VERDICTS.ABSENT_FROM_CLIENT },
      { method: 'DELETE', path: '/v1/accounts', expected: VERDICTS.ABSENT_FROM_CLIENT },
    ]) {
      const [judged] = evaluate({
        journey: [
          {
            service: 'identity',
            method: wrong.method,
            path: wrong.path,
            operationId: null,
            why: 'a synthetic requirement, so that the control measures the probe and nothing else',
          },
        ],
        documents: {
          identity: new Map([[`${wrong.method} ${wrong.path}`, 'someOperationId']]),
        },
        clients: { identity: probed },
      });
      assert.equal(
        judged.verdict,
        wrong.expected,
        `${wrong.method} ${wrong.path} was ${judged.verdict}; a probe that cannot tell a method ` +
          'or a path apart is not measuring either',
      );
    }
  });

  it('every operation the six documents declare is reachable through the generated client', () => {
    // The invariant that makes `absent-from-client` mean what it says. If a
    // document declares an operation and the committed client does not have it,
    // the generator or the pipeline lost something, and that IS this repository's
    // — so the verdict has to be trustworthy before anyone acts on it.
    const unreachable = [];
    for (const entry of index.services) {
      const document = documents[entry.service];
      const client = clients[entry.service];
      for (const label of document.keys()) {
        if (!client.has(label)) unreachable.push(`${entry.service}: ${label}`);
      }
    }
    assert.deepEqual(
      unreachable,
      [],
      `the generated client cannot reach ${unreachable.length} operation(s) its own vendored ` +
        'document declares. The generator dropped them, or the committed tree is not what the ' +
        'pinned generator produces. This is this repository to fix, and it is the verdict the ' +
        'two failing tests below never produce.',
    );
  });

  it('every generated method reaches a path its own document declares', () => {
    // The other direction, and it is a different failure. A generated function
    // whose (method, url) is in no document means the tree and the index have
    // parted in a way no sha256 comparison can see, because the bytes on disk
    // still hash to what the index says.
    const undocumented = [];
    for (const entry of index.services) {
      const document = documents[entry.service];
      const client = clients[entry.service];
      for (const [label, name] of client) {
        if (!document.has(label)) undocumented.push(`${entry.service}: ${label} as \`${name}\``);
      }
    }
    assert.deepEqual(
      undocumented,
      [],
      `the generated client issues ${undocumented.length} operation(s) no vendored document ` +
        'declares. Either the tree was hand-edited — which regeneration reverts — or the index ' +
        'and the tree describe different documents.',
    );
  });

  it('a customer can send a transactional message', () => {
    // courier, and the answer is yes. This is in the suite on purpose: a file
    // whose every red says the same thing is a complaint, not a measurement, and
    // the launch-scope question about courier deserves a computed answer rather
    // than a sentence in a report that goes stale the way a number in a comment
    // does. courier-26 is three commits behind the vendored copy and has changed
    // the document since; that is a staleness report's business, not this test's.
    const missing = missingIn(6);
    assert.deepEqual(
      missing.map((f) => `${f.method} ${f.path}`),
      [],
      `courier cannot send a transactional message through this client:\n\n` +
        `${formatFindings(missing, { detail: 'full' })}`,
    );
  });
});

describe('the customer path a customer cannot yet walk', () => {
  it('a customer can create an account, invite a member, accept the invitation, and obtain a session', () => {
    // THE FINDING. Step 1 works, step 4's methods exist, step 6 works, and steps
    // 2 and 3 do not — so the client can sign a person in and can then do nothing
    // with them. `POST /v1/users` creates a user; the document says in as many
    // words that it does not create a session, and it says nothing at all about
    // an account.
    const missing = missingIn(2).concat(missingIn(3));
    assert.deepEqual(
      missing.map((f) => `${f.method} ${f.path}`),
      [],
      `a customer cannot onboard a tenant through this client, and the reason is not in this ` +
        'repository. Ten operations identity SERVES are written down in no document of its own, ' +
        "so no amount of regenerating produces a method for them.\n\n" +
        `${formatFindings(missing, { detail: 'full' })}\n` +
        "WHAT CLOSES IT, and it is not this repository:\n" +
        '  identity adds the ten to `openapi/v1.yaml`, with operationIds and request and\n' +
        '  response schemas, and re-vendors. Its own internal/httpapi/openapi_drift_test.go\n' +
        '  already holds all ten in a `knownDrift` map whose comment says the list "cannot\n' +
        "  grow and cannot be emptied\" — closing it is DECISIONS.md D1 there, and D1 is a\n" +
        '  decision somebody has to make in identity.\n\n' +
        'WHAT MUST NOT BE DONE, and this file is where that is written down so the next\n' +
        '  reader finds it before they try:\n' +
        '  do not hand-write `createAccount` into src/services/identity/sdk.gen.ts. It would\n' +
        "  compile, it would pass every other test here, and it would be reverted by the next\n" +
        '  `npm run vendor` — a method whose generated siblings are absent, shipping a lie\n' +
        '  about what the document says. `test/hand-edit-is-reverted.test.mjs` would go red and\n' +
        '  would be right to.\n\n' +
        'WHAT THIS REPOSITORY OWES THE READER INSTEAD: this file, and the report that\n' +
        '  quotes it. The gap is upstream, and the one thing that was missing was a\n' +
        "  measurement of it in the language a customer writes in.\n",
    );
  });

  it("a customer can put this platform's sign-in on their own product", () => {
    // THE SECOND FINDING, and the one that is NOT upstream. identity documents all
    // nine of these operations — in `openid/openid.yaml`, a SECOND document in the
    // same repository, kept separate because RFC 8414 and OpenID Connect Discovery
    // fix the metadata paths at `/.well-known/…` and core's convention puts every
    // cafaye path under a single `/v1` prefix. The separation is a correct
    // decision by identity.
    //
    // It has a consequence here that nobody had priced: `specs/index.json` records
    // one `path` per service, `openapi-ts.config.ts` derives its service list from
    // that index, and each service generates into `src/services/<service>/`. So
    // this client has zero of the OIDC protocol surface and cannot acquire any of
    // it by re-vendoring, however many times `npm run vendor -- --bump` is run.
    // A customer integrating hosted identity for SSO reads the discovery document
    // first, and this client does not have it.
    //
    // No third verdict was invented for this. `no-vendored-document` is the finding:
    // the operation is documented and this repository does not vendor the document
    // that documents it.
    const missing = missingIn(5);
    assert.deepEqual(
      missing.map((f) => `${f.method} ${f.path}`),
      [],
      `a customer cannot integrate this platform's OpenID Connect provider through this ` +
        'client, and the reason is structural rather than upstream.\n\n' +
        `${formatFindings(missing, { detail: 'full' })}\n` +
        'These operations ARE documented — in identity\'s `openid/openid.yaml`, which is a\n' +
        '  SECOND document in the same repository and which identity keeps separate on\n' +
        '  purpose. This repository vendors ONE document per service, because\n' +
        '  `specs/index.json` has a single `path` field per entry and `openapi-ts.config.ts`\n' +
        '  writes each service into `src/services/<service>/`. So no re-vendor can bring\n' +
        '  them in, and the gap will not close on its own.\n\n' +
        "WHAT CLOSES IT, and it is this repository's:\n" +
        '  key `specs/index.json` by DOCUMENT rather than by service, and give\n' +
        '  `openapi-ts.config.ts` an output directory per document, because two\n' +
        '  documents for one service cannot share `src/services/identity/`. That is\n' +
        '  an architectural change to how this package is laid out, not a packet of\n' +
        '  documentation fixes, and it wants its own diff and its own review. This\n' +
        '  test is the thing that fails until somebody does it.\n',
    );
  });
});
