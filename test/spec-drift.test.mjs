// Every vendored document is what its service said AT THE COMMIT THIS REPOSITORY
// RECORDS — and every recorded commit still resolves.
//
// THIS IS THE DELIVERABLE of cafaye-ts-01b, and it exists because the client was
// describing services that had moved underneath it. When this packet started,
// `identity` was vendored at `35c2576` and its repository was at `793977b`; the
// document in between grew from 16 operations to 31, and this package described a
// service that had not had a scoped API key route for months. Nothing was red. The
// sha256 test in `vendored-specs.test.mjs` was green, because it checks the vendored
// bytes against the index, and both of those were stale together.
//
// THE CLAIM, STATED PRECISELY, BECAUSE THE PRECISION IS THE POINT
//
// This file asserts one thing:
//
//   > for each service, specs/<service>.yaml is byte-for-byte the contents of
//   > <repository>:<path> at <commit>, read with `git cat-file` out of a local
//   > checkout.
//
// Not "is what the service says now". Not "is what the working tree has". The
// recorded commit. That distinction is borrowed wholesale from pantry's
// `tests/recorded_copy.rs`, and it is borrowed because pantry already paid for the
// other version. Its `tests/drift.rs` compared against the working tree, so
// `identity-09` and `muse-06` landing turned *pantry's* gate red — and each red was
// reported as pantry being broken, in a repository nobody had touched. Pantry was
// not broken. The copies had not been refreshed.
//
// Here the same thing would be worse, because the vendored document is the artifact
// the generator reads. A test that compared against the working tree would turn
// red every time any service merged, and every one of those reds would be reported
// against `cafaye-ts` — the one repository in the fleet whose gate is green on
// purpose when nothing about it is wrong.
//
// THREE TESTS, THREE DIFFERENT CLAIMS, AND THE ORDER MATTERS
//
//   1. every recorded ref is a full sha that RESOLVES in its own checkout.
//      Without this, the test below is `stale.is_empty()` over a loop that may
//      measure nothing at all — which is a gate that reports success while
//      testing nothing, and is the single most expensive shape a test can have.
//
//   2. every vendored document is byte-identical to its source at the recorded
//      ref. THE GATE. A document edited here, or a commit bumped without
//      re-copying, both fail — and both are defects in THIS repository.
//
//   3. how far behind each recorded ref is, printed on every run. A REPORT, not a
//      gate. See "why a staleness budget and not a zero" below for why it is not
//      a gate and why it is not nothing either.
//
// THE SHALLOW-CLONE CASE IS A FAILURE, NOT A SKIP AND NOT A PASS
//
// The instruction this file answers says it plainly: "including the shallow-clone
// case, where the recorded ref is not in local history and the honest failure is
// 'cannot verify', not 'verified'". So:
//
//   * no workspace at all           -> SKIP, loudly, naming what was searched
//   * workspace present, ref absent -> FAIL, "cannot verify", with the fix
//
// Those are not the same answer and they are not interchangeable. A self-hoster
// installs this from npm with no sibling checkouts, and this suite must still pass
// for them — `vendored-specs.test.mjs` is what proves it, entirely offline. But a
// CI job that HAS the fleet and cannot resolve `identity` at `35c2576` has learned
// nothing, and reporting that as six passes is the failure this file is written to
// make impossible.
//
// No network. Every call here is against the local object store — `cat-file`,
// `rev-parse`, `rev-list`. `test/suite-is-offline.test.mjs` enforces that across
// the suite and this file is written to pass it, which is also why the resolution
// logic lives in `scripts/lib/workspace.mjs` and is shared with `scripts/vendor.mjs`
// rather than written a second time.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { REPO_ROOT, SHA_PATTERN, readIndex, sha256, specPathFor } from '../scripts/lib/specs.mjs';
import {
  commitsBehind,
  exists,
  isShallow,
  noWorkspaceError,
  originUrl,
  publishedHead,
  readDocumentAt,
  repositorySlug,
  resolveWorkspace,
} from '../scripts/lib/workspace.mjs';

/**
 * The six, written out rather than derived from the index.
 *
 * Same reason as `vendored-specs.test.mjs`: every loop below iterates the index, so
 * an index missing a service would sail through all of them. "cafaye-ts's drift
 * test covers five services" is a narrower version of the bug this test exists to
 * catch, and narrowing it is what let this month's drift accumulate in the first
 * place — the question was never asked of the services nobody was looking at.
 */
const FLEET = ['identity', 'billing', 'muse', 'darkroom', 'pantry', 'courier'];

/**
 * How many commits a recorded ref may fall behind before it is a failure here.
 *
 * Not zero. Zero puts this back where it started — red the moment any service
 * merges, which is precisely the defect pantry's `tests/drift.rs` had. Not
 * unbounded. Unbounded is the "quiet and still wrong" this replaces: the gate goes
 * green, the document is accurate as of its recorded ref, and nobody has been told
 * that identity has merged fifteen times since.
 *
 * Nine is the number pantry uses and the reasoning generalises to this fleet's
 * merge rate: roughly a working day. A copy inside the budget is refreshed by a
 * person noticing the printed report; one outside it says the refresh has been
 * missed long enough to be worth stopping for. The number is a policy, not a fact,
 * and it is here rather than in a comment so that changing it is a visible diff.
 */
const STALENESS_BUDGET_COMMITS = 9;

const index = await readIndex();
const byService = new Map(index.services.map((s) => [s.service, s]));

const { dir: workspace, tried } = await resolveWorkspace(index, null);

/**
 * Say the workspace could not be found, and skip the calling test.
 *
 * A skip is a skip, and this file says so rather than letting a green run imply a
 * verification that never happened. Pantry's `skip_without_workspace` is the model:
 * "A drift check that cannot see the real services has proven nothing, so this is
 * a skip and not a pass."
 *
 * `t.skip()` rather than a `return`, and that choice has a measurable consequence:
 * `node --test` counts a skipped test in `# skipped` and NOT in `# pass`, so
 * `bin/prime`'s output distinguishes "verified all six" from "verified nothing"
 * without a reader having to parse a message. pantry's version returns, which
 * prints its warning to stderr and counts as a pass — correct, and still exactly
 * the shape that lets a report be muted, so it is not copied.
 *
 * The `return` after it is unreachable in practice and load-bearing in intent: it
 * stops the rest of the test body from running if a future node version made
 * `t.skip()` non-throwing.
 */
function skipWithoutWorkspace(t) {
  t.skip(
    `no cafaye workspace found.\n` +
      `${noWorkspaceError(index, tried)}\n` +
      `This is a skip, not a pass — nothing was verified. The offline checks in ` +
      `vendored-specs.test.mjs did run: they prove the vendored bytes match ` +
      `specs/index.json, which is a consistency check and not a provenance check. ` +
      `Set CAFAYE_WORKSPACE to compare against the real repositories.`,
  );
  return;
}

/** A checkout for one service, or a message saying which of the six is missing. */
function checkoutFor(service) {
  return path.join(workspace, service);
}

describe('every recorded ref resolves', () => {
  it('records a full 40-character sha for all six, and it is lower-case hex', (t) => {
    if (workspace === null) return skipWithoutWorkspace(t);
    for (const service of FLEET) {
      const entry = byService.get(service);
      assert.ok(entry, `${service} is missing from specs/index.json`);
      assert.match(
        entry.commit,
        SHA_PATTERN,
        `${service}: recorded commit is ${JSON.stringify(entry.commit)}, not a full 40-character ` +
          `sha. A branch name or an abbreviated sha is a question whose answer changes over time, ` +
          `and it cannot be resolved by \`git cat-file\` — which means every check in this file ` +
          `would degrade into measuring nothing while reporting success.`,
      );
      assert.equal(
        entry.commit,
        entry.commit.toLowerCase(),
        `${service}: recorded commit is not lower-case hex`,
      );
    }
  });

  it('has a checkout for each of the six, in a directory whose origin is the recorded repository', async (t) => {
    if (workspace === null) return skipWithoutWorkspace(t);
    // Origin is checked because vendoring from the wrong clone is precisely the
    // untraceable specification this whole exercise exists to prevent, and a
    // checkout at the right path with the wrong remote is the shape that mistake
    // takes. `scripts/vendor.mjs` refuses it too; this is the same refusal from
    // the other direction.
    //
    // Compared as `owner/name`, not as a URL string. The index records an SSH
    // remote because PLAN.md §1 makes that the house remote, and a CI job
    // legitimately holds an HTTPS clone of the same repository — asserting the
    // exact string would make this check answer "is this the right transport"
    // instead of "is this the right repository", which is the question worth asking
    // and the one that catches a fork.
    for (const service of FLEET) {
      const entry = byService.get(service);
      const checkout = checkoutFor(service);

      assert.ok(
        await exists(path.join(checkout, '.git')),
        `${service}: no checkout at ${checkout}. The workspace ${workspace} was chosen because ` +
          `it held at least one of the six; that is not evidence about the other five, and this ` +
          `test reports each one individually rather than accepting the first match.`,
      );

      const origin = await originUrl(checkout);
      const have = repositorySlug(origin);
      assert.ok(
        have !== null,
        `${service}: ${checkout} has origin ${JSON.stringify(origin)}, which is not a remote ` +
          `URL this check can read an owner and a name out of, so the provenance claim for this ` +
          `service cannot be checked at all.`,
      );
      assert.equal(
        have,
        repositorySlug(entry.repository),
        `${service}: ${checkout} has origin ${origin} (${have}), but specs/index.json says the ` +
          `source is ${entry.repository} (${repositorySlug(entry.repository)}). Vendoring from a ` +
          `fork is exactly the untraceable specification this test exists to prevent.`,
      );
    }
  });

  it('can read every recorded commit out of its own checkout', async (t) => {
    if (workspace === null) return skipWithoutWorkspace(t);
    // The precondition for the gate below, stated separately so that a shallow
    // clone produces "cannot verify" rather than six confusing "cannot read
    // <path>" errors that look like a vendoring bug.
    const unreadable = [];
    const shallow = [];

    for (const service of FLEET) {
      const entry = byService.get(service);
      const checkout = checkoutFor(service);

      try {
        await readDocumentAt(checkout, entry.commit, entry.path, service);
      } catch (cause) {
        const isShallowClone = (await isShallow(checkout)) === true;
        unreadable.push(
          `  ${service}: ${cause.message}` +
            (isShallowClone
              ? `\n    ${checkout} is a SHALLOW clone (depth-limited history), which cannot ` +
                `resolve ${entry.commit.slice(0, 12)}. Un-shallow it — \`git -C ${checkout} ` +
                `fetch --unshallow\` — or re-vendor with \`npm run vendor -- --bump\`. This is ` +
                `"cannot verify", NOT "verified".`
              : ''),
        );
        if (isShallowClone) shallow.push(service);
      }
    }

    assert.deepEqual(
      unreadable,
      [],
      `${unreadable.length} of ${FLEET.length} recorded commits could not be read from a local ` +
        `checkout, so this run CANNOT verify the vendored documents:\n\n${unreadable.join('\n')}\n\n` +
        `The check below is not allowed to report success over a commit it could not read. That ` +
        `is the difference between "the document matches" and "I did not look".`,
    );
    assert.deepEqual(shallow, [], 'a shallow clone cannot resolve an old recorded ref');
  });
});

describe('every vendored document is what its service said at the recorded commit', () => {
  for (const service of FLEET) {
    it(`${service}: ${byService.get(service).spec} is byte-identical to ${byService.get(service).path} at ${byService.get(service).commit.slice(0, 12)}`, async (t) => {
      if (workspace === null) return skipWithoutWorkspace(t);
      const entry = byService.get(service);

      // Read from git, never the working tree. This is the line the whole file
      // turns on: the claim is about a named commit, and a checkout sitting on a
      // branch is not a claim about what that commit contained.
      const upstream = await readDocumentAt(
        checkoutFor(service),
        entry.commit,
        entry.path,
        service,
      );
      const vendored = await readFile(specPathFor(entry));

      assert.ok(
        vendored.equals(upstream),
        `${service}: ${entry.spec} is NOT what ${entry.repository}:${entry.path} said at ` +
          `${entry.commit}.\n` +
          `  vendored ${vendored.length} bytes, sha256 ${sha256(vendored)}\n` +
          `  at that ref ${upstream.length} bytes, sha256 ${sha256(upstream)}\n` +
          `  first difference at line ${firstDifferingLine(vendored, upstream)}\n\n` +
          `The index records ${entry.sha256.slice(0, 16)}… and the file on disk has ` +
          `${sha256(vendored).slice(0, 16)}…, so one of these is a hand-edit and the other is ` +
          `the vendored copy. Neither is a state this repository should be in:\n` +
          `  - edited by hand        -> re-vendor; AGENTS.md says never hand-edit specs/\n` +
          `  - commit bumped, no re-copy -> the index now describes bytes that are not here.\n` +
          `Either way the fix is one command: \`npm run vendor -- --service ${service}\`, and if ` +
          `the operation count moved, \`expectOperations\` in specs/index.json moves in the SAME commit.`,
      );

      // The digest the index records, checked against the digest just measured
      // from git. Redundant with the byte comparison on purpose: it is the one
      // assertion that reads as a fact about the index rather than a comparison,
      // and it names the number when they disagree.
      assert.equal(
        sha256(vendored),
        entry.sha256,
        `${service}: the vendored document hashes to ${sha256(vendored).slice(0, 16)}… but ` +
          `specs/index.json records ${entry.sha256.slice(0, 16)}…`,
      );
    });
  }

  it('all six agree, and the report says how many were actually compared', async (t) => {
    if (workspace === null) return skipWithoutWorkspace(t);
    // Non-vacuity. `stale.is_empty()` over a loop that skipped everything is
    // `assert.ok(true)` with a reassuring name, and the count is what distinguishes
    // the two.
    let compared = 0;
    for (const service of FLEET) {
      const entry = byService.get(service);
      const upstream = await readDocumentAt(
        checkoutFor(service),
        entry.commit,
        entry.path,
        service,
      );
      const vendored = await readFile(specPathFor(entry));
      if (vendored.equals(upstream)) compared += 1;
    }
    assert.equal(
      compared,
      FLEET.length,
      `only ${compared} of ${FLEET.length} vendored documents match their source at the ` +
        `recorded commit. A gate that verifies five of six and reports success is the ` +
        `six-of-six problem in miniature.`,
    );
  });
});

describe('how far behind the recorded refs are', () => {
  it('prints a distance for each service and fails only past the budget', async (t) => {
    if (workspace === null) return skipWithoutWorkspace(t);
    // A report, not a gate, and the distinction is the whole design.
    //
    // `kit/tests/staleness.py` says the same thing in its own docstring — "a stale
    // copy is LEGAL — it is a copy that has not been bumped yet — and a scheduled
    // report that is red every week is a report that gets muted". A merge in
    // `identity` must not be able to turn THIS repository's gate red; that is
    // exactly the failure MD15 ruled on and pantry's `tests/drift.rs` shipped.
    //
    // So the distances print on every run, the total is asserted non-zero so the
    // report cannot pass over nothing, and a copy past the budget fails with the
    // command that closes it.
    let current = 0;
    let behind = 0;
    const unmeasured = [];
    const overBudget = [];

    for (const service of FLEET) {
      const entry = byService.get(service);
      const checkout = checkoutFor(service);

      const head = await publishedHead(checkout);
      if (head === null) {
        unmeasured.push(`${service} (${checkout} resolves no published head)`);
        continue;
      }

      const distance = await commitsBehind(checkout, entry.commit, head);
      if (distance === null) {
        // Not 0. "I could not tell" is a different claim from "there is nothing
        // between them", and reporting a shallow clone's unresolvable ref as
        // `current` is how a fleet ends up believing it is up to date because the
        // thing that would have told it otherwise could not run.
        unmeasured.push(
          `${service} (${entry.commit.slice(0, 12)} is not in this checkout's history — a ` +
            `shallow clone, or a ref nobody has)`,
        );
        continue;
      }

      if (distance === 0) {
        current += 1;
        process.stderr.write(`    current  ${service} @ ${entry.commit}\n`);
      } else {
        behind += 1;
        process.stderr.write(
          `    behind   ${service} @ ${entry.commit} — ${distance} commit(s) behind ${head.slice(0, 12)}\n`,
        );
        if (distance > STALENESS_BUDGET_COMMITS) {
          overBudget.push(`  ${service} is ${distance} commit(s) behind (${entry.commit} vs ${head})`);
        }
      }
    }

    process.stderr.write(
      `\n    vendored spec staleness: ${current} current, ${behind} behind, ` +
        `${unmeasured.length} unmeasured, ${FLEET.length} services total ` +
        `(budget: ${STALENESS_BUDGET_COMMITS} commits)\n`,
    );
    for (const note of unmeasured) process.stderr.write(`    UNMEASURED ${note}\n`);

    assert.ok(
      current + behind > 0,
      `no service was measured at all — every one was unmeasurable, so this report says ` +
        `nothing about anything.\n${unmeasured.join('\n')}`,
    );

    assert.deepEqual(
      overBudget,
      [],
      `${overBudget.length} vendored document(s) more than ${STALENESS_BUDGET_COMMITS} commits ` +
        `behind the service they were taken from:\n${overBudget.join('\n')}\n\n` +
        `This is the budget, not a judgement about the merge. A document inside the budget is ` +
        `legal and this report is how you find it; one outside it means the refresh has been ` +
        `missed long enough to be worth stopping for.\n\n` +
        `Close each one with:\n  npm run vendor -- --bump --service <service>\n` +
        `  npm run generate\n  bin/prime`,
    );
  });
});

/**
 * The first line where two blobs differ, 1-indexed.
 *
 * For a message that does not send the reader to `diff` to work out where to look.
 * pantry's `recorded_copy.rs` has the identical helper for the identical reason, and
 * the two having it independently is the one piece of this file that is not
 * surprising.
 */
function firstDifferingLine(left, right) {
  const a = left.toString('utf8').split('\n');
  const b = right.toString('utf8').split('\n');
  const at = a.findIndex((line, i) => b[i] !== line);
  return at === -1 ? Math.min(a.length, b.length) + 1 : at + 1;
}