// The six source repositories: where they are, and how to read one out of them at
// a recorded commit.
//
// WHY THIS IS A SEPARATE MODULE AND NOT A COPY OF scripts/vendor.mjs
//
// `scripts/vendor.mjs` and `test/spec-drift.test.mjs` both need to answer the same
// three questions — where is the workspace, what is a service's published head, and
// what bytes did its document have at a given sha — and they must answer them
// identically. Two implementations is two answers, and the failure mode is the one
// this repository already paid for twice: `scripts/lib/specs.mjs`'s own header
// records that "a measurement that is computed two ways is a measurement that will be
// reported two ways", and MD6's first pass found "almost no machine-readable API
// surface" because its glob matched files *named* `openapi*` and missed everything
// under `openapi/`. A drift test that looked in a different place than the vendor
// would report a clean run over a workspace neither had read.
//
// The vendor imports this; the test imports this. Neither owns it.
//
// WHY EVERY READ GOES THROUGH GIT AND NEVER THE WORKING TREE
//
// `git cat-file -p <commit>:<path>` is the only read path, for one reason: the
// recorded commit is the provenance claim, and a script that copied whatever happened
// to be checked out would make that claim unfalsifiable. It is also what makes
// re-vendoring idempotent — the same command reads the same bytes out of the same
// shas and produces no diff.
//
// NONE OF THIS CONTACTS A REMOTE. Every function here is the local object store.
// That is not an accident and not a simplification: a self-hoster installs this
// package from npm with no sibling checkouts and no reachable remotes, and
// `test/suite-is-offline.test.mjs` exists to keep it that way. What this module can
// do depends entirely on what is already on disk, and every caller is required to say
// so rather than to assume it.

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { REPO_ROOT, SHA_PATTERN } from './specs.mjs';

const execFileAsync = promisify(execFile);

/** A git call against a local checkout. Throws with git's own message attached. */
export async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (cause) {
    const detail = (cause.stderr || cause.message || '').trim();
    throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${detail}`);
  }
}

/**
 * Is there something at this path?
 *
 * Named for what it asks rather than what it answers, and that is not pedantry:
 * `stat` follows symlinks and returns a File regardless of whether it is a
 * directory, so a `git worktree` checkout — whose `.git` is a FILE containing a
 * `gitdir:` pointer, not a directory — is found here. This repository sits in a
 * worktree, and a check that asked for `isDirectory` would have concluded the whole
 * fleet was missing while standing next to it.
 */
export async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the directory holding the sibling checkouts.
 *
 * Resolution order: `--workspace`, then `$CAFAYE_WORKSPACE`, then `../` and
 * `../../cafaye` relative to this repository. Whichever is chosen is returned
 * alongside every location that was tried, because a resolver that silently picked a
 * directory is a resolver that read the wrong bytes once.
 *
 * Partial workspaces are legal on purpose: a maintainer bumping one service should
 * not have to clone the other five, so "holds at least one checkout the index names"
 * is the bar. Every caller still checks the six individually and reports each one it
 * cannot find — a directory that is a workspace for four services and not for two
 * must not read as a workspace for all six.
 */
export async function resolveWorkspace(index, explicit) {
  const wanted = new Set(index.services.map((s) => s.service));
  // Deduplicated and order-preserving: a caller who passes `--workspace` and also
  // has CAFAYE_WORKSPACE set to the same directory should not see that path listed
  // twice in an error message, which reads as though two different places were tried
  // and failed.
  const candidates = [
    ...(explicit ? [explicit] : []),
    process.env.CAFAYE_WORKSPACE,
    path.resolve(REPO_ROOT, '..'),
    path.resolve(REPO_ROOT, '..', '..', 'cafaye'),
  ]
    .filter(Boolean)
    .map((c) => path.resolve(c))
    .filter((c, i, all) => all.indexOf(c) === i);

  const tried = [];
  for (const dir of candidates) {
    tried.push(dir);
    if (!(await exists(dir))) continue;
    for (const service of wanted) {
      if (await exists(path.join(dir, service, '.git'))) return { dir, tried };
    }
  }
  return { dir: null, tried };
}

/** The error a caller shows when `resolveWorkspace` found nothing. */
export function noWorkspaceError(index, tried) {
  return (
    `cannot find a workspace holding the cafaye checkouts.\n` +
    `Looked in:\n${tried.map((d) => `  ${d}`).join('\n')}\n` +
    `Pass --workspace <dir>, or set CAFAYE_WORKSPACE. It must be a directory ` +
    `containing a checkout of at least one of: ${index.services.map((s) => s.service).join(', ')}.`
  );
}

/** The commit a checkout's HEAD is at. Throws unless it is a full 40-character sha. */
export async function headCommit(checkout) {
  const sha = (await git(checkout, ['rev-parse', 'HEAD'])).trim();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`${checkout}: HEAD is not a 40-character sha (got ${JSON.stringify(sha)})`);
  }
  return sha;
}

/**
 * The commit a checkout's published head is at, or null.
 *
 * `refs/remotes/origin/master` before `HEAD`, on purpose. A checkout that has been
 * sitting on a branch all week is not reporting what the fleet would pull, and the
 * question this answers — "how far behind is this copy?" — is about the published
 * line. Taken from pantry's `pin::published_head`, because the two repositories are
 * asking the same question of the same repositories and the answer should not depend
 * on which one you asked.
 */
export async function publishedHead(checkout) {
  for (const candidate of [
    'refs/remotes/origin/master',
    'refs/remotes/origin/main',
    'master',
    'main',
    'HEAD',
  ]) {
    try {
      const value = (await git(checkout, ['rev-parse', candidate])).trim();
      if (SHA_PATTERN.test(value)) return value;
    } catch {
      // Not present in this clone. Try the next name.
    }
  }
  return null;
}

/**
 * How many commits `older` is behind `newer`, or null if it cannot be told.
 *
 * null rather than 0, and the distinction is the whole value of the function: 0
 * claims the two are identical, and "I could not tell" is a different claim. A
 * shallow clone whose recorded ref was never fetched answers here, and reporting it
 * as `0` would report a service as current when nothing was compared.
 */
export async function commitsBehind(checkout, older, newer) {
  try {
    const out = await git(checkout, ['rev-list', '--count', `${older}..${newer}`]);
    const n = Number.parseInt(out.trim(), 10);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** Is this checkout a shallow one? A shallow clone cannot resolve an old ref. */
export async function isShallow(checkout) {
  try {
    return (await git(checkout, ['rev-parse', '--is-shallow-repository'])).trim() === 'true';
  } catch {
    return false;
  }
}

/** A checkout's `origin` URL, or null when it has no remote. Reads config; contacts nothing. */
export async function originUrl(checkout) {
  try {
    return (await git(checkout, ['config', '--get', 'remote.origin.url'])).trim();
  } catch {
    return null;
  }
}

/**
 * The `owner/name` a remote URL names, or null when it is not a recognisable one.
 *
 * The comparison is on the slug rather than on the URL string, and the reason is
 * concrete rather than tidy. `specs/index.json` records
 * `git@github.com:cafaye/identity.git` because PLAN.md §1 makes SSH the house
 * remote for a cafaye repository. A CI job, a self-hoster and a laptop all
 * legitimately hold an HTTPS clone of the same repository, and asserting the exact
 * URL would turn "this is the right repo" into "this is the right transport",
 * which is a different question and not the one worth asking.
 *
 * Three URL shapes are accepted because all three are things people actually type:
 *
 *   git@github.com:cafaye/identity.git        SSH, what the index records
 *   ssh://git@github.com/cafaye/identity.git  SSH, explicit scheme
 *   https://github.com/cafaye/identity.git    HTTPS, what a CI runner clones
 *
 * `.git` is stripped and a trailing slash is tolerated, because `identity` and
 * `identity.git` are the same repository and a mismatch on the suffix would be a
 * false alarm on the one check that exists to catch real ones.
 */
export function repositorySlug(remote) {
  if (typeof remote !== 'string' || remote === '') return null;
  const trimmed = remote.trim().replace(/\.git\/?$/, '').replace(/\/+$/, '');
  const scp = /^[^@\s]+@([^:\s]+):(.+)$/.exec(trimmed);
  if (scp) return `${scp[1]}/${scp[2]}`;
  const url = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/]+)\/(.+)$/i.exec(trimmed);
  if (url) return `${url[2]}/${url[3]}`;
  return null;
}

/**
 * Read one document out of a checkout AT a commit, or say precisely why not.
 *
 * Three failures with three different fixes, kept distinct because collapsing them
 * into "could not read" is what makes a skip unfixable:
 *
 *   - the commit is not in this clone  (a shallow one, or a ref nobody fetched)
 *   - the commit is not a commit      (a branch name or an abbreviated sha)
 *   - the path does not exist there   (the document moved or was removed upstream)
 *
 * The middle case is worth its own message because it is the one a typo in
 * specs/index.json produces, and it is the case where the recorded sha cannot be
 * honoured at all.
 */
export async function readDocumentAt(checkout, commit, specPath, service) {
  if (!SHA_PATTERN.test(commit)) {
    throw new Error(
      `${service}: recorded commit ${JSON.stringify(commit)} is not a full 40-character sha. ` +
        `A branch name and an abbreviated sha both change what they mean over time, which ` +
        `is the property this index exists to remove. Re-vendor with --bump.`,
    );
  }
  try {
    const stdout = await git(checkout, ['cat-file', '-p', `${commit}:${specPath}`]);
    return Buffer.from(stdout, 'utf8');
  } catch (cause) {
    throw new Error(
      `${service}: cannot read ${specPath} at ${commit} from ${checkout}.\n${cause.message}\n` +
        `Either that commit is not in this clone, or the document is not at that path there. ` +
        `Un-shallow the clone (git fetch --unshallow) and re-run; if the document genuinely ` +
        `moved, re-vendor with --bump and update \`path\` in specs/index.json in the same commit.`,
    );
  }
}