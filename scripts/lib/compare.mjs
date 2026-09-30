// Byte comparison of two generated trees, and the read of git's index.
//
// Shared by `scripts/generate.mjs --check` and by the tests, because a
// comparison that is written twice is a comparison that will eventually report
// two different answers about the same tree.

import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Every file under `dir`, as repo-relative POSIX paths, sorted. */
export async function listFiles(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    if (cause.code === 'ENOENT') return out;
    throw cause;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/**
 * Compare `expectedRoot` against `actualRoot` for the named services.
 *
 * Returns a list of human-readable differences. Empty means identical. Both
 * directions are checked: a file only on one side is a difference, and so is a
 * file present on both with different bytes. The first direction is the one a
 * `git diff` misses when the tree is untracked, which is why this exists at all.
 */
export async function compareTrees(expectedRoot, actualRoot, services) {
  const differences = [];
  for (const service of services) {
    const expectedDir = path.join(expectedRoot, service);
    const actualDir = path.join(actualRoot, service);
    const expected = await listFiles(expectedDir);
    const actual = await listFiles(actualDir);
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);

    for (const file of expected) {
      if (!actualSet.has(file)) {
        differences.push(`${service}: only in the committed tree: ${file}`);
        continue;
      }
      const a = await readFile(path.join(expectedDir, file));
      const b = await readFile(path.join(actualDir, file));
      if (!a.equals(b)) {
        differences.push(`${service}: differs: ${file} (${a.length} bytes committed, ${b.length} bytes regenerated)`);
      }
    }
    for (const file of actual) {
      if (!expectedSet.has(file)) differences.push(`${service}: only in the regenerated tree: ${file}`);
    }
  }
  return differences;
}

/** `git ls-files` for the repository, one path per line. */
export async function gitTrackedFiles(cwd) {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split('\0').filter(Boolean);
}

/** Is this path tracked by git? */
export async function isTracked(cwd, relativePath) {
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', relativePath], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** Is this path ignored by git? The question `git check-ignore` actually answers. */
export async function isIgnored(cwd, relativePath) {
  try {
    await execFileAsync('git', ['check-ignore', '-q', '--', relativePath], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** Run git and return trimmed stdout, throwing with git's own message on failure. */
export async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch (cause) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(cause.stderr || cause.message).trim()}`);
  }
}
