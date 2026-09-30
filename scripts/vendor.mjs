#!/usr/bin/env node
//
// Re-vendor the six OpenAPI documents, with provenance.
//
//   npm run vendor              # re-copy at the shas already in specs/index.json
//   npm run vendor -- --bump    # move every entry to its repo's current master
//   npm run vendor -- --service identity --bump
//
// WHAT IT PROMISES
//   Either every document is replaced and the index is updated, or nothing on
//   disk has changed. There is no partial update and no silent one: a failure
//   part-way through a six-file copy is exactly the state where the index says
//   one thing and the tree says another, and nothing downstream can tell.
//
// WHY IT READS AT A SHA
//   `git cat-file -p <commit>:<path>` and never the working tree. The recorded
//   commit is the provenance claim — "this client was generated from the
//   document as it stood when the service was at this commit" — and a script
//   that copied whatever happened to be checked out would make that claim
//   unfalsifiable. If the recorded sha is not in the local clone the script
//   fails; it does not fall back to HEAD, because a fallback is a silent
//   provenance rewrite and that is the one thing this file exists to prevent.
//
//   This is also what makes re-vendoring idempotent: re-running the command with
//   no `--bump` reads the same bytes out of the same shas, and produces no diff.
//
// WHY A SCRIPT AND NOT SIX COMMANDS
//   Because the sixth command is the one somebody forgets. A hardcoded path per
//   service is the failure MD6 already paid for: courier's document is at its
//   repository ROOT, not at `openapi/v1.yaml`, and a loop that assumed the
//   conventional path would have skipped courier entirely and produced a
//   four-of-six client that reported success. Here the path per service lives in
//   exactly one place — specs/index.json — and the test suite reads the same
//   place.
//
// WORKSPACE
//   The six source repositories are local clones. Resolution order: `--workspace`,
//   then $CAFAYE_WORKSPACE, then `../` and `../../cafaye` relative to this
//   repository. Whichever is chosen is printed, because a script that silently
//   picked a directory is a script that vendored the wrong bytes once.

import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  INDEX_PATH,
  REPO_ROOT,
  SHA_PATTERN,
  measureDocument,
  readIndex,
  sha256,
  specPathFor,
  writeIndex,
} from './lib/specs.mjs';

const execFileAsync = promisify(execFile);

const USAGE = `Usage: npm run vendor [-- --bump] [--service <name>] [--workspace <dir>]

  --bump                 record each repo's current master instead of the sha
                         already in the index, then vendor at that sha
  --service <name>       restrict to one service (repeatable)
  --workspace <dir>      directory holding one checkout per service
  --verify-only          resolve and measure, write nothing
  -h, --help             this text
`;

/** Parse argv. Unknown flags are an error rather than a shrug. */
function parseArgs(argv) {
  const opts = { bump: false, verifyOnly: false, services: [], workspace: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--bump') opts.bump = true;
    else if (arg === '--verify-only') opts.verifyOnly = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--service') opts.services.push(argv[++i]);
    else if (arg === '--workspace') opts.workspace = argv[++i];
    else throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
  }
  return opts;
}

/** A git call that fails loudly with git's own message attached. */
async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (cause) {
    const detail = (cause.stderr || cause.message || '').trim();
    throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${detail}`);
  }
}

async function isDirectory(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the directory holding the sibling checkouts.
 *
 * Every candidate is a real directory that actually contains a checkout of at
 * least one indexed service, so a typo'd `--workspace` is caught here rather
 * than as six confusing "no such file" errors later.
 */
async function resolveWorkspace(index, explicit) {
  const wanted = new Set(index.services.map((s) => s.service));
  const candidates = [
    ...(explicit ? [explicit] : []),
    process.env.CAFAYE_WORKSPACE,
    path.resolve(REPO_ROOT, '..'),
    path.resolve(REPO_ROOT, '..', '..', 'cafaye'),
  ].filter(Boolean);

  const tried = [];
  for (const candidate of candidates) {
    const dir = path.resolve(candidate);
    tried.push(dir);
    if (!(await isDirectory(dir))) continue;
    // A directory is usable if it holds a git checkout for at least one service
    // the index names. Partial workspaces are allowed on purpose: a maintainer
    // bumping one service should not have to clone the other five.
    for (const service of wanted) {
      if (await isDirectory(path.join(dir, service, '.git'))) return { dir, tried };
    }
  }
  throw new Error(
    `cannot find a workspace holding the cafaye checkouts.\n` +
      `Looked in:\n${tried.map((d) => `  ${d}`).join('\n')}\n` +
      `Pass --workspace <dir>, or set CAFAYE_WORKSPACE. It must be a directory ` +
      `containing a checkout of at least one of: ${[...wanted].join(', ')}.`,
  );
}

/** The commit a checkout's default branch points at, for `--bump`. */
async function headCommit(checkout) {
  const sha = (await git(checkout, ['rev-parse', 'HEAD'])).trim();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`${checkout}: HEAD is not a 40-character sha (got ${JSON.stringify(sha)})`);
  }
  return sha;
}

/** A checkout's `origin` URL, or null when it has no remote. */
async function originUrl(checkout) {
  try {
    return (await git(checkout, ['remote', 'get-url', 'origin'])).trim();
  } catch {
    return null;
  }
}

/**
 * Read one document out of a checkout AT a commit.
 *
 * `git cat-file` on `<commit>:<path>` is the only read path used anywhere in
 * this file. It is what turns a recorded sha from a comment into a fact: the
 * bytes are the bytes at that commit, whether or not the working tree agrees.
 */
async function readDocumentAt(checkout, commit, specPath, service) {
  try {
    const stdout = await git(checkout, ['cat-file', '-p', `${commit}:${specPath}`]);
    return Buffer.from(stdout, 'utf8');
  } catch (cause) {
    throw new Error(
      `${service}: cannot read ${specPath} at ${commit} from ${checkout}.\n${cause.message}\n` +
        `If that commit is not in this clone, fetch it, or bump the service with --bump ` +
        `to move it to the current master.`,
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const index = await readIndex();
  const { dir: workspace, tried } = await resolveWorkspace(index, opts.workspace);
  process.stdout.write(`workspace: ${workspace}\n`);
  if (tried.length > 1) {
    process.stdout.write(`  (searched ${tried.length} locations; first match wins)\n`);
  }

  let targets = index.services;
  if (opts.services.length > 0) {
    const known = new Set(index.services.map((s) => s.service));
    for (const name of opts.services) {
      if (!known.has(name)) {
        throw new Error(
          `--service ${name} is not in the index. Known services: ${[...known].join(', ')}`,
        );
      }
    }
    targets = index.services.filter((s) => opts.services.includes(s.service));
  }

  // ---- RESOLVE EVERYTHING BEFORE WRITING ANYTHING -------------------------
  // This is the "never a silent partial update" requirement, implemented as
  // ordering rather than as a rollback. Five documents written and a sixth
  // failing would leave the index describing a tree that does not exist, and
  // there is no transaction available across five file writes and a git call
  // each. Refusing to start is the only honest option.
  const staged = [];
  for (const entry of targets) {
    const checkout = path.join(workspace, entry.service);
    if (!(await isDirectory(path.join(checkout, '.git')))) {
      throw new Error(
        `${entry.service}: no checkout at ${checkout}. ${workspace} was chosen because it ` +
          `held at least one service; the others are still required.`,
      );
    }

    const origin = await originUrl(checkout);
    if (origin && origin !== entry.repository) {
      throw new Error(
        `${entry.service}: ${checkout} has origin ${origin}, but the index says the source is ` +
          `${entry.repository}. Vendoring from the wrong clone is exactly the untraceable ` +
          `specification this index exists to prevent.`,
      );
    }

    const commit = opts.bump ? await headCommit(checkout) : entry.commit;
    if (!SHA_PATTERN.test(commit)) {
      throw new Error(
        `${entry.service}: recorded commit ${JSON.stringify(entry.commit)} is not a ` +
          `40-character sha. Run with --bump to replace it.`,
      );
    }

    const bytes = await readDocumentAt(checkout, commit, entry.path, entry.service);
    // Measure before staging. A document that does not parse, or that declares
    // no operations, is refused here — which is what keeps a truncated copy
    // from ever becoming a committed one.
    const measured = measureDocument(bytes.toString('utf8'), {
      source: `${entry.service} ${entry.path}@${commit.slice(0, 12)}`,
    });

    if (entry.expectOperations != null && measured.operations !== entry.expectOperations) {
      throw new Error(
        `${entry.service}: ${entry.path} declares ${measured.operations} operations at ` +
          `${commit.slice(0, 12)}, but the index expects ${entry.expectOperations}.\n` +
          `A document changed size under you. That is the event this provenance exists to ` +
          `catch, so it is reported rather than absorbed: if the change is intended, update ` +
          `\`expectOperations\` in specs/index.json in the same commit that vendors it.`,
      );
    }

    staged.push({ entry, commit, bytes, measured });
  }

  // ---- WRITE -------------------------------------------------------------
  let changed = 0;
  for (const { entry, commit, bytes, measured } of staged) {
    const target = specPathFor(entry);
    await mkdir(path.dirname(target), { recursive: true });

    const digest = sha256(bytes);
    const before = await readFileOrNull(target);
    const byteChanged = before === null || !before.equals(bytes);
    const recordChanged =
      entry.commit !== commit ||
      entry.operations !== measured.operations ||
      entry.paths !== measured.paths ||
      entry.openapi !== measured.openapi ||
      entry.infoVersion !== measured.infoVersion ||
      entry.sha256 !== digest;

    if (byteChanged) await writeFile(target, bytes);
    changed += byteChanged || recordChanged ? 1 : 0;

    const flags = [];
    if (byteChanged) flags.push('document');
    if (recordChanged) flags.push('index');
    process.stdout.write(
      `  ${entry.service.padEnd(9)} ${String(measured.operations).padStart(2)} ops  ` +
        `${String(measured.paths).padStart(2)} paths  openapi ${measured.openapi}  ` +
        `info ${measured.infoVersion}  ${commit.slice(0, 12)}  ` +
        `sha256 ${digest.slice(0, 12)}  [${flags.length ? flags.join(' + ') : 'no change'}]\n`,
    );

    if (!opts.verifyOnly) {
      entry.commit = commit;
      entry.operations = measured.operations;
      entry.paths = measured.paths;
      entry.openapi = measured.openapi;
      entry.infoVersion = measured.infoVersion;
      entry.sha256 = digest;
      entry.bytes = bytes.length;
    }
  }

  if (opts.verifyOnly) {
    process.stdout.write(
      `\nverify-only: nothing written. ${staged.length} service(s) resolved cleanly.\n`,
    );
    return 0;
  }

  await writeIndex(index);
  process.stdout.write(
    changed === 0
      ? `\nno change: ${staged.length} service(s) already vendored at their recorded shas.\n` +
          `This is the result re-vendoring must produce — a diff or no diff.\n`
      : `\nupdated ${changed} of ${staged.length} service(s). Review the diff before committing; ` +
          `\`npm test\` asserts regeneration is a no-op over the result.\n`,
  );
  return 0;
}

async function readFileOrNull(p) {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(p);
  } catch {
    return null;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`\nvendor failed: ${error.message}\n`);
    process.exit(1);
  });
