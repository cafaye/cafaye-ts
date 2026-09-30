// Property 1: regeneration is idempotent, and the result is committed.
//
// THIS IS THE MOST VALUABLE TEST IN THE PACKET, and the reason is worth being
// explicit about. "Generated from the spec" is a claim a README makes and a
// consumer relies on. Without this test it is a claim. With it, it is a fact
// that is re-checked on every run of the suite: anyone can clone this repository,
// run `npm ci && npm test`, and learn that the 96 committed TypeScript files are
// exactly what the committed generator produces from the committed documents.
//
// It is also the only test here that catches a GENERATOR UPGRADE. Not the pin
// being bypassed — the pin is a version string and a version string is a claim —
// but a generator upgrade that changes the public surface. Bump
// @hey-api/openapi-ts, run the suite, and this fails with a diff rather than
// producing a quietly different client that nobody reviewed.
//
// HOW IT WORKS, AND WHY IT IS NOT SIMPLY `git diff`
//
// The test runs the real `npm run generate`, over the real config, over the real
// vendored documents, into the real output directory. That is the operation a
// maintainer performs, run against the same tree, so a passing result is a
// statement about the operation rather than about a simulation of it.
//
// It then asks git two questions, not one, because they fail differently:
//
//   `git diff --exit-code`      catches a file that EXISTS AND CHANGED BYTES.
//                               Misses a file the generator newly emitted,
//                               because an untracked file is not a diff.
//
//   `git status --porcelain`    catches BOTH. A changed file, a deleted file, and
//                               — the one `git diff` is blind to — a new file
//                               the generator started writing.
//
// The second question is the whole reason this is not the four-word test the
// brief describes. A generator upgrade that starts emitting an extra module is
// one of the most likely upgrades there is, and `git diff --exit-code` alone
// would report success while the published client quietly gained a file that was
// never reviewed.
//
// WHY THIS IS SLOW, AND WHY THAT IS FINE
//
// It regenerates all six services, twice over the course of the suite (once here,
// once in hand-edit-is-reverted.test.mjs). That is about two seconds of work. A
// gate whose job is proving byte-level determinism cannot be allowed to skip the
// step that does the proving, and `--test-concurrency=1` in package.json keeps
// these two files from interleaving their writes to the same tree — which would
// make this test fail for a reason that has nothing to do with the generator.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { git, gitTrackedFiles, listFiles } from '../scripts/lib/compare.mjs';
import { REPO_ROOT, readIndex } from '../scripts/lib/specs.mjs';

const execFileAsync = promisify(execFile);

const GENERATED_ROOT = path.join(REPO_ROOT, 'src', 'services');
const index = await readIndex();
const SERVICES = index.services.map((s) => s.service);

/** Run the real pipeline. No flags, no filtering: exactly what a maintainer runs. */
async function runGenerate() {
  const { stdout, stderr } = await execFileAsync('npm', ['run', '--silent', 'generate'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  return `${stdout}${stderr}`;
}

describe('regeneration is idempotent and committed', () => {
  let before_ = null;

  before(async () => {
    // Capture the tree as committed, before touching anything, so a failure can
    // say what the generator did rather than only that something is different.
    before_ = await listFiles(GENERATED_ROOT);
    assert.ok(before_.length > 0, 'there is no generated tree to test');
  }, { timeout: 120_000 });

  it('the generated tree is committed, one directory per indexed service', async () => {
    const tracked = new Set(await gitTrackedFiles(REPO_ROOT));
    const committed = [...tracked].filter((f) => f.startsWith('src/services/'));

    assert.ok(
      committed.length > 0,
      'git tracks nothing under src/services/. The generated code is supposed to be COMMITTED. ' +
        'If you have just gitignored it, undo that: this repository generates on purpose and ' +
        'ships the result.',
    );

    for (const service of SERVICES) {
      const files = committed.filter((f) => f.startsWith(`src/services/${service}/`));
      assert.ok(
        files.length > 0,
        `no committed generated file for ${service}. Every service in specs/index.json must ` +
          `have a committed tree.`,
      );
    }
  });

  it('re-running the generator leaves the committed tree byte-identical', async () => {
    await runGenerate();

    // `git diff --name-only` rather than `git diff --exit-code`: both answer the
    // same question, but this one returns the list of offenders instead of a
    // nonzero exit, so the failure message can name them. A gate that reports
    // "regeneration is not idempotent" and stops there has told the reader to go
    // and diff it themselves; naming the files is the difference between a test
    // that helps and one that nags.
    const changed = await git(REPO_ROOT, ['diff', '--name-only', '--', 'src/services']);
    assert.equal(
      changed,
      '',
      'regeneration changed files that are already committed:\n' +
        `${changed}\n\n` +
        'Either the generator is not deterministic, or @hey-api/openapi-ts was upgraded and ' +
        'the public surface moved. Both are legitimate events — review the diff and commit ' +
        'the regenerated tree. Do not adjust this test to make it pass.',
    );
  }, { timeout: 120_000 });

  it('regeneration produces no new, deleted or renamed files either', async () => {
    // The half `git diff --exit-code` cannot see. A generator that starts
    // emitting an extra module, or stops emitting one, changes the published
    // surface and leaves the working tree clean as far as a diff is concerned.
    const porcelain = await git(REPO_ROOT, ['status', '--porcelain', '--', 'src/services']);
    assert.equal(
      porcelain,
      '',
      'the working tree under src/services/ is not clean after regenerating:\n' +
        `${porcelain}\n\n` +
        '`git status` sees added, deleted and modified files; `git diff` sees only the ' +
        'last of those. A generator upgrade that adds or removes a module shows up here ' +
        'and nowhere else.',
    );
  }, { timeout: 120_000 });

  it('the file count and the service set are unchanged by regenerating', async () => {
    // Belt and braces to the test above, and the part that would catch a
    // generator that rewrites a file with the same path and the same bytes but a
    // different number of files elsewhere. Cheap, and it names the shape of the
    // failure rather than leaving it as a bare count mismatch.
    const after = await listFiles(GENERATED_ROOT);
    assert.deepEqual(
      after,
      before_,
      'the set of generated files changed. Names before -> after are printed above; ' +
        'review the diff and commit it rather than regenerating until it agrees.',
    );
    assert.equal(after.length, before_.length);
  });

  it('every generated file carries the DO NOT EDIT header', async () => {
    // The header is the first thing a person reads when they open one of these
    // files with the intention of changing it. If a generator upgrade drops it,
    // the tree becomes something a reasonable person will hand-edit, and this
    // repository's central property quietly stops holding.
    const { readFile } = await import('node:fs/promises');
    const files = await listFiles(GENERATED_ROOT);
    const missing = [];

    for (const file of files) {
      const contents = await readFile(path.join(GENERATED_ROOT, file), 'utf8');
      if (!contents.includes('DO NOT EDIT')) missing.push(file);
    }

    assert.deepEqual(
      missing,
      [],
      `generated files without a DO NOT EDIT header: ${missing.join(', ')}. ` +
        `openapi-ts.config.ts sets the header; a generator upgrade that ignores it would ` +
        `leave a tree people edit by hand, and hand-edits are reverted by regeneration.`,
    );
  });
});
