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
    pattern: /git[^'"\n]*\b(clone|pull|ls-remote)\b/,
    what: 'runs a git subcommand that contacts a remote',
    why: 'clone, pull and ls-remote all require a reachable remote',
  },
  {
    pattern: /\bremote\s+(get-url|add|set-url)\b/,
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
