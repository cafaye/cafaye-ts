// Property 5: a hand-edited generated file is caught.
//
// Regeneration being idempotent (property 1) and regeneration OVERWRITING a
// hand-edit are different claims, and only the second one is the one people
// worry about.
//
// Here is the failure they share. Somebody opens `types.gen.ts` to fix a
// misnamed type, or to add a comment, or to work around a generator bug at 11pm.
// They edit it. They commit. If `src/services/` were gitignored — the classic
// way a "committed generated code" packet silently becomes "generated at install
// time" — then:
//
//   `git diff --exit-code -- src/services`  PASSES. Vacuously. An untracked
//                                            directory has no diff.
//   `git status --porcelain`               shows nothing. Same reason.
//   regeneration                           writes the file again, so the edit
//                                            SURVIVES, and the next person has
//                                            no way to tell.
//
// Property 1 cannot catch that. This file can, and it does it the only way that
// means anything: by actually making the mistake, and asserting it is undone.
//
// So this test edits a real generated file, asserts the edit landed, runs the
// real pipeline, and asserts the file is byte-identical to what was committed.
// If regeneration ever stops being authoritative over its own output, this fails.
//
// It also asserts the failure it is standing in for: that `git diff` would NOT
// have noticed. That is the assertion that gives the edit-revert its value —
// without it, this is just a regeneration test wearing a disguise, and a reader
// cannot tell whether the .gitignore hazard is actually covered or merely
// described in a comment.
//
// IF THIS TEST FAILS, THE TREE IS THE PROBLEM, NOT THE TEST.
//
// A hand-edit surviving regeneration means the generator is no longer writing
// that file, or writing it somewhere else, or a `.gitignore` entry has made git
// stop seeing it. Investigate the tree. Do not delete this test.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { git, isIgnored, isTracked } from '../scripts/lib/compare.mjs';
import { REPO_ROOT, readIndex } from '../scripts/lib/specs.mjs';

const execFileAsync = promisify(execFile);

/**
 * The file to vandalise.
 *
 * `types.gen.ts` rather than `sdk.gen.ts` or a `core/` helper, because it is the
 * file a person is most likely to open: it is the readable one, it holds the
 * documentation prose, and it is the one where a wrong type name is most
 * tempting to fix by hand.
 */
const VICTIM = 'src/services/identity/types.gen.ts';

const index = await readIndex();
const SERVICES = index.services.map((s) => s.service);

/** A sentinel that could not plausibly be generator output. */
const SENTINEL = [
  '',
  '// ---------------------------------------------------------------------------',
  '// A HAND EDIT. This line exists so that hand-edit-is-reverted.test.mjs can',
  '// prove that regeneration removes it. If you are reading this in a diff and',
  '// you did not write it, run `npm run generate` and commit the result.',
  `export const HAND_EDIT_SENTINEL_${Date.now()} = 'this must not survive regeneration';`,
  '// ---------------------------------------------------------------------------',
  '',
].join('\n');

async function runGenerate() {
  await execFileAsync('npm', ['run', '--silent', 'generate'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

describe('a hand-edited generated file is caught', () => {
  let original = null;
  let edited = false;

  before(async () => {
    original = await readFile(path.join(REPO_ROOT, VICTIM), 'utf8');
  });

  after(async () => {
    // Leave the tree exactly as it was found, whatever happened above. A test
    // that can leave a repository dirty is a test people learn to run with
    // `git checkout` afterwards, and then it is not testing anything.
    if (edited) {
      await writeFile(path.join(REPO_ROOT, VICTIM), original);
      await runGenerate();
    }
  }, { timeout: 120_000 });

  it('the victim file is committed and not gitignored, so the test is meaningful', async () => {
    assert.ok(
      await isTracked(REPO_ROOT, VICTIM),
      `${VICTIM} is not tracked by git. If the generated tree is untracked, ` +
        `regeneration.test.mjs is passing vacuously and this test is proving nothing.`,
    );
    assert.ok(
      !(await isIgnored(REPO_ROOT, VICTIM)),
      `${VICTIM} is matched by .gitignore. This is the exact mistake the .gitignore ` +
        `comment at the top of that file is written to prevent.`,
    );
  });

  it('git would NOT notice the hand-edit, which is why regeneration has to undo it', async () => {
    // The assertion that gives the rest of this file its meaning. It runs the
    // failure mode deliberately and records that the cheap check misses it.
    edited = true;
    const withSentinel = `${original}\n${SENTINEL}`;
    await writeFile(path.join(REPO_ROOT, VICTIM), withSentinel);

    // 1. Prove the edit actually landed. A test that writes a file and then
    //    asserts it was overwritten passes just as happily if the write failed.
    const onDisk = await readFile(path.join(REPO_ROOT, VICTIM), 'utf8');
    assert.match(
      onDisk,
      /HAND_EDIT_SENTINEL/,
      'the sentinel did not land in the file, so the rest of this test would prove nothing',
    );

    // 2. The cheap check, on a file git is tracking, is expected to see it.
    //    This is the control: it proves git CAN see a change to this path, so a
    //    later "git saw nothing" is informative rather than a broken test.
    const trackedDiff = await git(REPO_ROOT, ['diff', '--name-only', '--', VICTIM]);
    assert.equal(
      trackedDiff,
      VICTIM,
      'git did not report a change to a tracked file that was just modified. Either git ' +
        'is not watching this path or the test is not running where it thinks it is.',
    );

    // 3. And now the hazard itself: hide the tree from git the way a stray
    //    .gitignore line would, and confirm the diff check goes blind. This is
    //    done with `git update-index --assume-unchanged`, which is reversible,
    //    local, and does not touch the index on disk.
    await git(REPO_ROOT, ['update-index', '--assume-unchanged', '--', VICTIM]);
    try {
      const blindDiff = await git(REPO_ROOT, ['diff', '--name-only', '--', 'src/services']);
      const blindStatus = await git(REPO_ROOT, ['status', '--porcelain', '--', 'src/services']);
      assert.equal(
        `${blindDiff}${blindStatus}`.trim(),
        '',
        'with the generated file hidden from git, `git diff` and `git status` were expected ' +
          'to report nothing. If they did not, this test no longer demonstrates the hazard ' +
          'it exists to guard against, and the comment above needs rethinking.',
      );
    } finally {
      await git(REPO_ROOT, ['update-index', '--no-assume-unchanged', '--', VICTIM]);
    }
  }, { timeout: 60_000 });

  it('regeneration reverts the hand-edit to the exact committed bytes', async () => {
    // The payload. The file currently carries the sentinel; run the real pipeline
    // and the sentinel must be gone, byte for byte.
    await runGenerate();

    const after_ = await readFile(path.join(REPO_ROOT, VICTIM), 'utf8');
    assert.equal(
      after_,
      original,
      'regeneration did not restore the committed bytes of a hand-edited generated file.',
    );
    assert.doesNotMatch(
      after_,
      /HAND_EDIT_SENTINEL/,
      'the hand-edit survived regeneration. The generated tree is not authoritative over ' +
        'its own output, which means it is being maintained by hand somewhere.',
    );
  }, { timeout: 120_000 });

  it('and the tree is clean again afterwards', async () => {
    const porcelain = await git(REPO_ROOT, ['status', '--porcelain', '--', 'src/services']);
    assert.equal(
      porcelain,
      '',
      `the generated tree is still dirty after regeneration:\n${porcelain}\n\n` +
        'Either the revert did not fully restore the file, or regeneration itself ' +
        'leaves something behind.',
    );
  });
});

describe('the generated tree is committed, not built at install time', () => {
  it('git tracks a generated file for every service in the index', async () => {
    for (const service of SERVICES) {
      const probe = `src/services/${service}/index.ts`;
      assert.ok(
        await isTracked(REPO_ROOT, probe),
        `${probe} is not tracked. A generated client that is not committed is a client ` +
          `that is regenerated at install time, which means every consumer's install ` +
          `depends on this repository's toolchain being available and unchanged.`,
      );
      assert.ok(
        !(await isIgnored(REPO_ROOT, probe)),
        `${probe} is gitignored — see the top of .gitignore for why that is the one ` +
          `mistake this file must never make.`,
      );
    }
  });

  it('nothing under src/services/ is ignored, not one path', async () => {
    // The per-service probes above check one file each. A pattern like
    // `src/services/*/core/` or `*.gen.ts` would pass all of them and still
    // untrack most of the tree, so this asks the question over every file.
    const { listFiles } = await import('../scripts/lib/compare.mjs');
    const files = await listFiles(path.join(REPO_ROOT, 'src', 'services'));
    assert.ok(files.length > 0);

    const ignored = [];
    const untracked = [];
    for (const file of files) {
      const relative = `src/services/${file}`;
      if (await isIgnored(REPO_ROOT, relative)) ignored.push(relative);
      if (!(await isTracked(REPO_ROOT, relative))) untracked.push(relative);
    }

    assert.deepEqual(ignored, [], `generated files that are gitignored: ${ignored.join(', ')}`);
    assert.deepEqual(
      untracked,
      [],
      `generated files that exist but are not committed: ${untracked.slice(0, 10).join(', ')}` +
        `${untracked.length > 10 ? ` (+${untracked.length - 10} more)` : ''}. ` +
        `Commit them: \`git add src/services\`.`,
    );
  });
});
