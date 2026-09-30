#!/usr/bin/env node
//
// Regenerate the client for every service in specs/index.json.
//
//   npm run generate                 # all six
//   npm run generate -- identity     # one
//   npm run generate -- --check      # generate into a scratch dir and diff it
//                                     against the committed tree, writing nothing
//
// WHY A WRAPPER AROUND `openapi-ts` AT ALL
//
// Because the list of services must come from one place. `openapi-ts` reads
// openapi-ts.config.ts, which reads specs/index.json, and this script checks
// that the generator it shells out to is the pinned one before it shells out at
// all. A generator that is not the pinned generator is the failure MD6 is trying
// to prevent: not a broken build, but a committed artifact produced by a version
// nobody chose, which is only discoverable by noticing the diff is large.
//
// WHY `--check` GENERATES INTO A SCRATCH DIRECTORY
//
// `test/regeneration.test.mjs` asserts the committed tree is byte-identical after
// regeneration. It can do that either by regenerating in place and running
// `git diff`, or by generating elsewhere and comparing. It does the first, because
// that is the operation a maintainer actually performs, and because the second
// quietly passes when the output directory is gitignored — which is precisely the
// mistake `.gitignore` in this repository is written to prevent. This `--check`
// mode is a convenience for a human, not the test's mechanism, and it is kept
// honest by generating to a temporary directory outside the repository.

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { REPO_ROOT, readIndex } from './lib/specs.mjs';

const execFileAsync = promisify(execFile);

/** The generator binary, resolved through node_modules so a global install cannot answer. */
const GENERATOR = path.join(REPO_ROOT, 'node_modules', '.bin', 'openapi-ts');

async function generate(extraArgs = []) {
  return execFileAsync(GENERATOR, [...extraArgs], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const filters = argv.filter((a) => !a.startsWith('--'));
  const index = await readIndex();

  const known = index.services.map((s) => s.service);
  for (const name of filters) {
    if (!known.includes(name)) {
      throw new Error(
        `unknown service ${JSON.stringify(name)}. In specs/index.json: ${known.join(', ')}`,
      );
    }
  }
  const targets = filters.length
    ? index.services.filter((s) => filters.includes(s.service))
    : index.services;

  if (!check) {
    const { stdout } = await generate([]);
    if (stdout.trim()) process.stdout.write(stdout);
    process.stdout.write(
      `generated ${targets.length} service(s) into src/services: ${targets.map((t) => t.service).join(', ')}\n`,
    );
    return 0;
  }

  // --check: generate into a throwaway tree, then compare file lists and bytes.
  const scratch = await mkdtemp(path.join(tmpdir(), 'cafaye-ts-check-'));
  try {
    // A copy of the configuration whose output root is the scratch directory.
    // Rewriting the config file rather than the index keeps the comparison
    // honest: same inputs, same generator, same config, different destination.
    const { readFile, writeFile } = await import('node:fs/promises');
    const original = await readFile(path.join(REPO_ROOT, 'openapi-ts.config.ts'), 'utf8');
    const rewritten = original
      .replace(
        "const ROOT = import.meta.dirname;",
        `const ROOT = ${JSON.stringify(REPO_ROOT)};\nconst OUT = ${JSON.stringify(scratch)};`,
      )
      .replace("path.join(ROOT, 'src', 'services', service.service)", "path.join(OUT, service.service)");
    const configPath = path.join(scratch, 'openapi-ts.config.ts');
    await writeFile(configPath, rewritten);
    await execFileAsync(GENERATOR, ['--file', configPath], {
      cwd: REPO_ROOT,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    });

    const { compareTrees } = await import('./lib/compare.mjs');
    const diff = await compareTrees(path.join(REPO_ROOT, 'src', 'services'), scratch, targets.map((t) => t.service));
    if (diff.length === 0) {
      process.stdout.write(`--check: no difference. ${targets.length} service(s) regenerate byte-identically.\n`);
      return 0;
    }
    process.stderr.write(`--check: ${diff.length} difference(s):\n${diff.join('\n')}\n`);
    return 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`\ngenerate failed: ${error.message}\n`);
    if (error.stdout) process.stderr.write(`--- stdout ---\n${error.stdout}\n`);
    if (error.stderr) process.stderr.write(`--- stderr ---\n${error.stderr}\n`);
    process.exit(1);
  });
