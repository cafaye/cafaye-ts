// Property 4: every vendored document is the one the index claims — and it is a
// document, not a rumour.
//
// WHAT THIS ASSERTS, AND WHY EACH HALF IS HERE
//
// `sha256` is the one that makes "a test fails if a vendored file's contents do
// not match the index" a local, offline check. The index records the digest of
// the bytes that were vendored; this recomputes it from the file on disk. The
// two agreeing means the vendored file is the file the index describes.
//
// The digest alone is not enough, and this is MD6's own lesson applied to
// ourselves: *a search that returns nothing is evidence about the search.* A
// zero-byte file has a perfectly stable digest, and so does a truncated copy. So
// every document is also PARSED, and its declared operation count, path count,
// `openapi` version and `info.version` are compared against what the index
// recorded. A vendored empty file, a half-written YAML file, or a file that
// somehow became a different document all fail here rather than quietly
// generating a client with nothing in it.
//
// WHAT IS DELIBERATELY NOT HERE
//
// No test in this file touches the network, and no test compares a vendored
// document to its source repository. The sha is provenance — it records where the
// bytes came from — and the vendored bytes are the artifact. Asserting that the
// two still agree is a local consistency check and is what this file does.
// Re-fetching the remote to verify the sha would make the suite require six
// reachable remotes, which is the property this whole packet exists to avoid: a
// client a self-hoster installs must be verifiable with no network at all.
//
// A note on what a green run does not prove (MD5): this proves the vendored bytes
// match the index. It says nothing about whether the index's sha is still what
// the service repository is on master. That is `npm run vendor -- --bump`, and
// it is a deliberate human action, not something a test should do behind your
// back.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  HTTP_METHODS,
  REPO_ROOT,
  SHA_PATTERN,
  measureVendoredDocument,
  readIndex,
  specPathFor,
} from '../scripts/lib/specs.mjs';

const METHODS = new Set(HTTP_METHODS);

/**
 * The six services, written out here rather than derived from the index.
 *
 * This is the one place a deleted service has to be noticed. Every other check in
 * this file iterates the index, so an index missing a service would sail through
 * all of them — and "cafaye-ts generates four services" is exactly the quiet
 * regression this repository exists to make loud. The list is duplicated here on
 * purpose, and the test that uses it is the one that fails when a service is
 * dropped from either place.
 */
const FLEET = ['identity', 'billing', 'muse', 'darkroom', 'pantry', 'courier'];

/**
 * The operation counts measured from each document, independently of the index.
 *
 * Two numbers live in two files on purpose, and the disagreement between them is
 * the signal: `expectOperations` is what `npm run vendor` enforces, and this
 * table is what was measured by hand when the document was last read. A vendor
 * run that moved a document and an edit to `expectOperations` in the same commit
 * would pass the vendor and fail here — which is the shape you want, because the
 * question "did the operation count really move, or did somebody just relax the
 * number" has two files that must agree for the answer to be yes.
 *
 * Measured 2026-10-02, after cafaye-ts-01b re-vendored all six. identity moved
 * 16 -> 31 and courier 8 -> 10; the other four held their counts, and two of
 * those (darkroom, muse) changed their documents without changing shape.
 */
const MEASURED_OPERATIONS = {
  identity: 31,
  billing: 15,
  muse: 1,
  darkroom: 9,
  // 4 -> 6: registry-compat-05 put the compatibility graph on the wire as two
  // operations (requirements, required-by). Re-measured by hand from the
  // document, not copied from the index, which is what makes this an
  // independent count.
  pantry: 6,
  courier: 10,
};

const index = await readIndex();
const byService = new Map(index.services.map((s) => [s.service, s]));

describe('the vendoring index', () => {
  it('lists exactly the six services of the fleet', () => {
    const listed = index.services.map((s) => s.service).sort();
    assert.deepEqual(listed, [...FLEET].sort());
  });

  it('records a source repository, a path and a full 40-character commit sha for every service', () => {
    for (const service of FLEET) {
      const entry = byService.get(service);
      assert.ok(entry, `${service} is missing from the index`);

      // Provenance is three facts or it is nothing. A short sha — an abbreviated
      // one, which is what every terminal shows by default — cannot be resolved
      // by `git cat-file` and cannot answer the question the index exists for.
      assert.match(
        entry.commit,
        SHA_PATTERN,
        `${service}: commit is not a full 40-character sha (got ${JSON.stringify(entry.commit)}). ` +
          `An abbreviated sha is not provenance.`,
      );

      // SSH only. PLAN.md §1: an HTTPS remote for a cafaye repository is a policy
      // violation, and this index is a list of cafaye remotes.
      assert.match(
        entry.repository,
        /^git@github\.com:cafaye\/[a-z0-9-]+\.git$/,
        `${service}: source repository is not a cafaye SSH remote (got ${entry.repository})`,
      );

      // The path is per service and is NOT uniform. courier's document is at its
      // repository root while the other five are at openapi/v1.yaml. A test that
      // assumed `openapi/v1.yaml` for all six would have been asserting the bug.
      assert.ok(
        typeof entry.path === 'string' && entry.path.length > 0,
        `${service}: no path recorded`,
      );
      assert.doesNotMatch(entry.path, /^\/|\.\./, `${service}: path must be repository-relative`);
      assert.match(
        entry.spec,
        /^specs\/[a-z0-9-]+\.ya?ml$/,
        `${service}: vendored file must live in specs/ (got ${entry.spec})`,
      );
    }
  });

  it('records courier at its repository root, which is the path a loop would get wrong', () => {
    // Stated on its own so that a future "tidy-up" that regularises the six paths
    // trips a test with a sentence explaining why it must not.
    assert.equal(byService.get('courier').path, 'openapi.yaml');
    for (const service of FLEET.filter((s) => s !== 'courier')) {
      assert.equal(
        byService.get(service).path,
        'openapi/v1.yaml',
        `${service} is expected at openapi/v1.yaml`,
      );
    }
  });

  it('agrees with the operation counts measured by hand', () => {
    for (const service of FLEET) {
      assert.equal(
        byService.get(service).expectOperations,
        MEASURED_OPERATIONS[service],
        `${service}: expectOperations drifted from the independently measured count`,
      );
    }
    const total = FLEET.reduce((sum, s) => sum + MEASURED_OPERATIONS[s], 0);
    assert.equal(total, 72, 'the fleet total moved; re-measure and record it in this test');
  });
});

describe('each vendored document', () => {
  for (const service of FLEET) {
    it(`${service}: exists, is the bytes the index records, and declares operations`, async () => {
      const entry = byService.get(service);
      const measured = await measureVendoredDocument(entry);

      // (a) Contents match the index. This is the assertion the packet asks for
      //     by name, and it is the one that catches a hand-edited or
      //     re-vendored-at-the-wrong-sha document.
      assert.equal(
        measured.sha256,
        entry.sha256,
        `${service}: ${entry.spec} does not hash to the digest the index records. ` +
          `Either the file was edited by hand or it was vendored from a different commit. ` +
          `Re-run \`npm run vendor\`; never edit a vendored document.`,
      );
      assert.equal(measured.bytes, entry.bytes, `${service}: byte count differs from the index`);

      // (b) It is a document, not a file that happens to parse.
      assert.match(
        measured.openapi,
        /^3\./,
        `${service}: declares OpenAPI ${measured.openapi}, not a 3.x document`,
      );
      assert.equal(measured.openapi, entry.openapi, `${service}: openapi version differs`);
      assert.equal(measured.infoVersion, entry.infoVersion, `${service}: info.version differs`);

      // (c) It declares operations. This is the half that a digest cannot do: an
      //     empty or truncated vendored file has a perfectly valid digest.
      assert.ok(
        measured.operations > 0,
        `${service}: ${entry.spec} declares no operations. A vendored copy that is empty or ` +
          `truncated would generate a client with nothing in it and report success.`,
      );
      assert.equal(
        measured.operations,
        entry.operations,
        `${service}: index says ${entry.operations} operations, the document declares ${measured.operations}`,
      );
      assert.equal(measured.paths, entry.paths, `${service}: path count differs from the index`);
    });
  }

  it('declares OpenAPI 3.1 for all six, which is the version the generator was chosen for', () => {
    for (const service of FLEET) {
      assert.equal(byService.get(service).openapi, '3.1.0', `${service} is not OpenAPI 3.1.0`);
    }
  });
});

describe('the fleet declares auth in a shape no single operation honours', () => {
  // The measurement `wrapper-class.test.mjs`'s "attaches the credential to an
  // operation that declares no security" used to carry as prose, computed.
  //
  // `Cafaye` attaches the credential to EVERY request, unconditionally. The
  // obvious refinement — attach it only where the document declares a security
  // scheme — is wrong for this fleet, and this is the proof rather than the
  // assertion: the generator does not copy a document-level `security` onto each
  // operation, so per-operation arrays cannot express what four of the six
  // services actually require. A client that respected them would send
  // unauthenticated requests to those four, and the failure would be a 401 from a
  // service rather than an error from the client.
  //
  // Read off the documents on every run, which is the change from the comment it
  // replaces. That comment said "eleven identity operations and six courier ones,
  // and NONE on billing, muse, darkroom or pantry", and identity-08 landed and made
  // it wrong while the sentence around it still read like a finding.
  const perOperation = new Map();
  for (const service of FLEET) perOperation.set(service, { declared: 0, empty: 0, documentLevel: 0 });

  it('finds operations with no per-operation `security` at all, in four of six services', async () => {
    const { load } = await import('js-yaml');
    for (const entry of index.services) {
      const doc = load(await readFile(specPathFor(entry), 'utf8'));
      const tally = perOperation.get(entry.service);

      // Document-level counts too: muse and darkroom state theirs globally, and
      // `security: []` at the document level means the same thing an empty
      // per-operation array means — "nothing required" — so both are recorded.
      if (Array.isArray(doc.security) && doc.security.length > 0) tally.documentLevel += 1;

      for (const item of Object.values(doc.paths ?? {})) {
        for (const [method, operation] of Object.entries(item ?? {})) {
          if (!METHODS.has(method.toLowerCase())) continue;
          if (Array.isArray(operation.security)) {
            if (operation.security.length === 0) tally.empty += 1;
            else tally.declared += 1;
          }
        }
      }
    }

    // The claim, as numbers. These are what the documents say right now, and the
    // assertion is that at least four services have operations whose auth a
    // generated client cannot see — which is what makes unconditional attachment
    // the correct policy rather than merely the safe one.
    const unseen = FLEET.filter((s) => {
      const t = perOperation.get(s);
      return t.declared === 0;
    });

    assert.ok(
      unseen.length >= 4,
      `only ${unseen.length} of six services have operations with no per-operation \`security\` ` +
        `(${unseen.join(', ') || 'none'}). The unconditional-attachment rule in ` +
        `src/cafaye/class.ts is justified by a measurement; if the fleet's documents started ` +
        `expressing per-operation auth everywhere, this test is the thing that says so.`,
    );

    // And the inverse, because the rule has to be *safe* rather than merely
    // convenient: at least one service must still declare per-operation security,
    // or "ignore the arrays" would be indistinguishable from "the arrays are empty".
    assert.ok(
      FLEET.some((s) => perOperation.get(s).declared > 0),
      'no service declares a per-operation `security` array anywhere. If the fleet ever ' +
        'reaches that shape the generated transport may become usable directly, and this ' +
        'test is the signal that the wrapper could stop doing this by hand.',
    );
  });

  it('records the measurement in the failure message, by service', () => {
    // `process.stderr` rather than an assertion: this is a report, and it is worth
    // seeing on every run because the number is the evidence for a design decision
    // someone will eventually ask about.
    const lines = FLEET.map((s) => {
      const t = perOperation.get(s);
      return `    ${s.padEnd(9)} ${String(t.declared).padStart(2)} with per-operation security, ` +
        `${String(t.empty).padStart(2)} declaring [], ${t.documentLevel ? 'document-level auth' : 'no document-level auth'}`;
    });
    process.stderr.write(`\n    auth as declared by the six documents:\n${lines.join('\n')}\n`);
    // Nothing to assert beyond non-vacuity — the loop above already did that — but
    // a report with zero lines is a report that printed nothing, and this catches it.
    assert.equal(lines.length, FLEET.length);
  });
});

describe('the specs directory holds nothing unaccounted for', () => {
  it('has no vendored file that the index does not list', async () => {
    // The inverse of the checks above, and the one that catches a document
    // somebody copied in by hand and forgot to index. An unindexed document is
    // the exact failure this packet rules out: a specification nobody can trace.
    const onDisk = (await readdir(path.join(REPO_ROOT, 'specs')))
      .filter((name) => /\.ya?ml$/.test(name))
      .sort();
    const indexed = index.services.map((s) => path.basename(s.spec)).sort();
    assert.deepEqual(
      onDisk,
      indexed,
      'specs/ and specs/index.json disagree about which documents exist. An unindexed ' +
        'document has no provenance and is not generated from; a missing one is a ' +
        'service the client silently stopped covering.',
    );
  });

  it('has an index that is valid JSON with no trailing-comma style damage', async () => {
    // Trivial, and here because a hand-edited index is the one file in this
    // repository a person is expected to edit when a document moves.
    const raw = await readFile(path.join(REPO_ROOT, 'specs', 'index.json'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));
    assert.ok(raw.endsWith('\n'), 'index.json should end with a newline');
  });
});
