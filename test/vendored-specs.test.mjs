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
  REPO_ROOT,
  SHA_PATTERN,
  measureVendoredDocument,
  readIndex,
} from '../scripts/lib/specs.mjs';

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
  pantry: 4,
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
    assert.equal(total, 70, 'the fleet total moved; re-measure and record it in this test');
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
