// The suite must be able to run with no network and no reachable remotes.
//
// This file exists as a tripwire, and it is a tripwire against a specific,
// well-intentioned future change: somebody reading specs/index.json, seeing a
// column of commit shas, and concluding that the strongest possible test is to
// fetch each document from its repository and compare. That test would pass. It
// would also make `npm test` require six reachable remotes, which is the exact
// property this packet exists to remove — and it would make the failure mode of
// an offline self-hoster's first run be a network error rather than a result.
//
// The distinction, stated once so the next reader does not have to re-derive it:
//
//   the sha is PROVENANCE — a record of where these bytes came from
//   the vendored bytes are the ARTIFACT — what the client was actually built from
//   the tests assert those two are CONSISTENT, locally
//   `npm run vendor` is what reconciles them, and it is a human action
//
// WHAT THIS FILE EXCLUDES, AND WHY THAT IS HONEST RATHER THAN A LOOPHOLE
//
// It does not scan itself. The patterns below have to appear literally in this
// file's source in order to be searched for, so a file that scanned itself would
// always fail on its own pattern list. The exclusion is stated here rather than
// hidden in a filter: this one file is unverified by this one check, and the
// cost of that is low because the thing being protected is a property of the
// other six. What the other six are checked for is the real assertion.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { REPO_ROOT } from '../scripts/lib/specs.mjs';

const SELF = path.basename(import.meta.filename);

/**
 * Patterns that indicate a test reaching for something off this machine.
 *
 * `git ls-files`, `git diff`, `git check-ignore`, `git update-index` and
 * `git cat-file` on THIS repository are all fine — they read the local index and
 * the local object store, and the suite depends on them. What is forbidden is
 * anything that CONTACTS a remote, and anything that imports the one module in
 * this repository capable of doing so.
 *
 * Two of these rules were narrowed after they fired on something harmless, and
 * both narrowings are recorded here because the reasoning generalises.
 *
 * The vendor-script rule matches an IMPORT FORM rather than the bare filename:
 * `package-contents.test.mjs` names `scripts/vendor.mjs` in a comment explaining
 * precisely why it must not ship in the tarball, and the broader version failed
 * on that comment. A check broad enough to catch the documentation of a rule is
 * a check that eventually gets disabled.
 *
 * The URL rules require a URL to be ADJACENT TO A REQUEST, or to be naming a
 * document, rather than merely present. `readme-examples.test.mjs` asserts that
 * `createClient` keeps the `baseUrl` it was handed, and its fixture is the string
 * `https://identity.example.com` — a base URL, passed to a factory, never
 * fetched. A URL in a string is inert. A URL handed to `curl`, to `https.get` or
 * to a download helper is not, and neither is a URL ending in `.yaml` or naming
 * a schema, because that is "fetch the spec to be sure" in the shape it usually
 * takes.
 */
const FORBIDDEN = [
  {
    pattern: /(?:from|import|require)\s*\(?\s*['"`][^'"`]*vendor\.mjs/,
    what: 'imports scripts/vendor.mjs',
    why:
      'the vendor script is the only module here that resolves a recorded sha against a ' +
      'repository, so a test that imports it puts the network in the suite',
  },
  {
    pattern: /\bfetch\s*\(/,
    what: 'calls fetch(',
    why: 'a test that performs an HTTP request cannot run offline',
  },
  {
    pattern: /['"`]https?:\/\/\S+['"`][^\n]*\b(curl|wget|download|get|request|axios|undici)\b/,
    what: 'passes an http(s) URL to something that makes a request',
    why:
      'a URL handed to a request helper is a dependency on a remote server; a URL sitting ' +
      'in a string as a fixture is not',
  },
  {
    pattern: /['"`]https?:\/\/\S+(\.ya?ml|\.json|\/schema[^'"`]*|manifest\.schema)/,
    what: 'holds a URL naming a specification or a schema',
    why:
      'a document fetched over HTTP is exactly the "fetch the spec to be sure" change this ' +
      'file exists to catch, in the shape it usually takes',
  },
  {
    // `\bgit\b` and NOT `git`, and this is the THIRD narrowing of a rule in this
    // file, so the reason is the generalisation rather than the instance.
    //
    // It fired on `test/spec-drift.test.mjs`, on a comment reading "a CI job
    // legitimately holds an HTTPS clone of the same repository" — because
    // `git` with no left boundary matches inside "legitimately". The rule was
    // catching the word *legitimately*, not a subcommand. The prose was correct
    // and rewording it would be the third time this file's own header predicted:
    // "A check broad enough to catch the documentation of a rule is a check that
    // eventually gets disabled."
    //
    // THE OTHER HALF OF THE FIX IS WIDER, not narrower, and it is the more
    // important half. The rule used to exclude quotes between `git` and the
    // subcommand, which is what stops a rule spanning statements — and in doing
    // so it MISSED the most likely shape of the thing it forbids:
    //
    //     execFileSync("git", ["clone", url, dir])
    //
    // The quotes sit between `git` and `clone`, so both this rule and the one
    // before it reported that line clean. That is a hole in a tripwire whose
    // entire job is catching that line, and it was found while narrowing the
    // same pattern — so `[^'"\n]` becomes `[^\n]`. The newline exclusion stays,
    // because a rule that spans lines is a rule that fires on unrelated prose
    // somewhere else in the file, and one of those is a disabled check.
    pattern: /\bgit\b[^\n]*\b(clone|pull|ls-remote)\b/,
    what: 'runs a git subcommand that contacts a remote',
    why: 'clone, pull and ls-remote all require a reachable remote',
  },
  {
    // TWO spellings, because this guard has now caught one rewrite of itself.
    //
    // The rule used to name only the subcommand form (`git remote get-url
    // origin`), which is what `scripts/vendor.mjs` used to call. cafaye-ts-01b
    // rewrote it to `git config --get remote.origin.url` — the same read, a
    // different spelling, done for an unrelated reason — and the rule reported the
    // rewrite clean. It was caught by the self-test above and not by the tripwire,
    // which is exactly the failure the self-test exists to find: a guard with one
    // spelling of what it forbids.
    //
    // `remote.<name>.<key>` is the config form. The subcommand alternation stays
    // because `git remote add` and `git remote set-url` rewrite config without
    // naming it in that shape.
    pattern: /\bremote\s+(get-url|add|set-url|rm)\b|\bremote\.[a-z0-9_-]+\.(url|pushurl|fetch)\b/,
    what: 'inspects or rewrites git remotes',
    why: 'reading a local remote URL is harmless, but the habit it belongs to is not',
  },
];

describe('the test suite is offline', () => {
  const testDir = path.join(REPO_ROOT, 'test');

  it('finds the other test files to scan', async () => {
    const files = (await readdir(testDir)).filter((n) => n.endsWith('.test.mjs'));
    assert.ok(
      files.length >= 5,
      `expected at least five test files, found ${files.length}. This packet's five ` +
        `properties each need a test; if this fails, some were never written.`,
    );
    assert.ok(files.includes(SELF));
  });

  it('catches the shapes of each rule it was written to catch', () => {
    // THE RULE THAT PROVES THE RULES. Every entry in `FORBIDDEN` above is a claim
    // about what cannot appear in a test file, and a claim that is only ever
    // exercised by the ABSENCE of an offender is not verified at all — it is a
    // sentence. Three of these patterns have been changed in this file's history,
    // two narrowed and one widened, and all three changes were made by reading the
    // code rather than by being told a test failed. A rule that quietly stops
    // matching is invisible until the thing it guards is done, which is the worst
    // time to find out.
    //
    // Each line below is a snippet in the shape a violation actually takes, and
    // each is asserted CAUGHT. The second group is the other half: prose the rules
    // must NOT fire on, because a check that catches its own documentation is a
    // check that eventually gets disabled.
    const MUST_CATCH = [
      // The shape `scripts/lib/workspace.mjs` uses, and the one the git rule
      // missed until cafaye-ts-01b: quoted arguments between `git` and the
      // subcommand.
      `await execFileAsync('git', ['clone', url, dir]);`,
      `const { stdout } = await execFileAsync("git", ["clone", remote, dest]);`,
      `execFileSync("git", ["pull", "--rebase"]);`,
      `run("git", "ls-remote", origin);`,
      `await git(checkout, ['clone', '--depth', '1', remote]);`,
      // Bare forms, for completeness.
      `git clone --depth 1 https://example.com/x`,
      `git pull --rebase`,
      `git -C ../identity ls-remote origin`,
      `await import('node:child_process').then(m => m.exec('git clone'))`,
      `fetch('https://github.com/cafaye/identity/raw/main/openapi/v1.yaml');`,
      `import { vendor } from '../scripts/vendor.mjs';`,
      `require('../scripts/vendor.mjs');`,
      `git config --get remote.origin.url`,
      `execFileAsync('git', ['config', '--get', 'remote.origin.url'])`,
      `await x('https://example.com/openapi/v1.yaml');`,
      `remote get-url origin`,
      `git remote set-url origin https://example.com/x.git`,
      `git remote add upstream https://example.com/x.git`,
    ];

    for (const line of MUST_CATCH) {
      const rule = FORBIDDEN.find(({ pattern }) => pattern.test(line));
      assert.ok(
        rule,
        `no rule in this file matches a violation in its real shape:\n  ${line}\n` +
          `A tripwire that cannot fire is a comment. Add a pattern or widen an ` +
          `existing one — and never narrow one to make an assertion pass.`,
      );
    }

    const MUST_NOT_CATCH = [
      // The false positives that actually happened. "legitimately" contains "git",
      // and the first version of that rule matched it.
      `// a CI job legitimately holds an HTTPS clone of the same repository`,
      `// .gitignore is never stopped here`,
      `// the file was vendored from a clone at the recorded sha`,
      // The rules' own documentation, which must not be its own evidence.
      `// clone, pull and ls-remote all require a reachable remote`,
      `// package-contents.test.mjs names scripts/vendor.mjs in a comment`,
      `// https://identity.example.com is a base URL, never fetched`,
    ];

    for (const line of MUST_NOT_CATCH) {
      const rule = FORBIDDEN.find(({ pattern }) => pattern.test(line));
      assert.equal(
        rule,
        undefined,
        `a rule fires on prose it must not catch, which would fail every test file ` +
          `that explains itself:\n  ${line}\n  matched ${rule?.what}`,
      );
    }
  });

  for (const { pattern, what, why } of FORBIDDEN) {
    it(`no test file ${what}`, async () => {
      const files = (await readdir(testDir)).filter((n) => n.endsWith('.test.mjs') && n !== SELF);
      const offenders = [];

      for (const name of files) {
        const source = await readFile(path.join(testDir, name), 'utf8');
        if (pattern.test(source)) offenders.push(name);
      }

      assert.deepEqual(
        offenders,
        [],
        `${offenders.join(', ')} — ${why}. The sha in specs/index.json is provenance, the ` +
          `vendored bytes are the artifact, and the suite proves they are consistent ` +
          `without consulting either the network or a remote.`,
      );
    });
  }
});
