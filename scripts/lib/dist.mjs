// Load the package the way a consumer loads it: from `dist/`, not from `src/`.
//
// `src/` is TypeScript and cannot be imported by `node --test`, so every test
// that exercises the hand-written `Cafaye` class has to go through the build.
// That is the right place to be. `src/` is not what anybody installs, it does not
// go through `tsc`, and a test run against it would answer questions the
// consumer's runtime will not — the same argument
// `test/readme-examples.test.mjs` makes about resolving documented specifiers
// against the BUILT package rather than against `src/`.
//
// It also removes an ordering dependency. `test/package-contents.test.mjs`
// builds `dist/` as a side effect of running `npm pack`, which is why
// `readme-examples.test.mjs` can assume `dist/index.js` exists — but that
// assumption is a fact about alphabetical file order, and a file named
// `cafaye-*.test.mjs` would break it silently. `ensureBuilt()` builds on
// demand, so any test file can be run on its own with
//
//     node --test test/wrapper-errors.test.mjs
//
// and get the same answer it gets in the full suite. There is no sleep and no
// polling anywhere in here: the build is a subprocess, awaited to completion.
//
// WHY IT IS IN `scripts/lib/` AND NOT `test/lib/`
//
// It used to be `test/lib/dist.mjs`, and it moved when `scripts/capability.mjs`
// needed it. That script has to answer the same question this file answers — what
// can the BUILT client do — and a script reaching into `test/` for its own
// loader would make the test directory a library the shipped scripts depend on.
// `scripts/lib/` is where this repository keeps the things a script and a test
// both need; `specs.mjs` and `workspace.mjs` are already there for the same
// reason.
//
// `test/lib/dist.mjs` still exists and re-exports all of it, so that the seven
// test files importing it change nothing and a reader of a test file still sees
// a path that reads as test infrastructure.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { REPO_ROOT } from './specs.mjs';

const execFileAsync = promisify(execFile);

export { REPO_ROOT };

/** Absolute path to a built file under `dist/`. */
export function distPath(...segments) {
  return path.join(REPO_ROOT, 'dist', ...segments);
}

/**
 * Build `dist/` if it is not there, and return whether it had to.
 *
 * A stale `dist/` is worse than none: it would let a test pass against code that
 * is no longer the code in `src/`. So this only skips the build when the
 * entrypoint exists, and `bin/prime` runs `npm ci` and a typecheck before the
 * suite — the build here is the same `npm run build` `prepack` runs, so the two
 * cannot disagree.
 */
export async function ensureBuilt() {
  if (existsSync(distPath('index.js'))) return false;
  await execFileAsync('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (!existsSync(distPath('index.js'))) {
    throw new Error(
      '`npm run build` finished but produced no dist/index.js. The wrapper tests import the ' +
        'built package, so there is nothing to run them against.',
    );
  }
  return true;
}

/** Import a built module by its path under `dist/`. */
export async function loadDist(...segments) {
  await ensureBuilt();
  return import(new URL(`file://${distPath(...segments)}`).href);
}
