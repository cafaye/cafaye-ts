// Property 3: the published tarball contains no tests and no tooling.
//
// A package that ships its test suite ships its devDependencies' opinions, its
// generator configuration, and its vendoring workspace assumptions, to everyone
// who installs it. Worse, it ships them as FILES on disk in node_modules, where
// they are discoverable and where a reader reasonably assumes they are part of
// the contract.
//
// The check is `npm pack --dry-run`, which asks npm itself what it would
// publish. Asking npm is the point: the alternative is re-deriving the file list
// from `files` in package.json and calling that the answer, which is a test that
// passes whenever package.json is internally consistent — including when
// `files` is consistent and wrong. npm's own packing step also runs `prepack`,
// so this test additionally proves the build step that produces `dist/` actually
// works, on the way to answering the question.
//
// WHAT IS ASSERTED TO BE ABSENT, AND WHY EACH ONE
//
//   test/          the suite, and the reason `files` lists dist rather than src
//   scripts/       the vendoring and generation pipeline. This is the sharpest
//                  one: scripts/vendor.mjs contains six `git@github.com:cafaye/…`
//                  remotes, and shipping it tells every consumer that this
//                  package expects to be next to six git clones.
//   openapi-ts.config.ts   names the generator and the per-service output layout
//   tsconfig*.json         build configuration, and a `//` comment in ours that
//                          discusses a flag the generated code cannot satisfy —
//                          which is a note for maintainers, not for consumers
//   .github/       CI definitions
//   bin/           the gate, which shells out to npm
//   node_modules/  npm never packs it, but asserting it costs nothing and turns
//                  a surprising npm behaviour into a documented one
//   *.map          declaration and source maps. The generated tree is large
//                  enough that maps roughly double it, and the sources are
//                  shipped alongside the JavaScript, so a map that points at a
//                  path the consumer does not have is worse than no map.
//
// WHAT IS ASSERTED TO BE PRESENT, AND WHY
//
// The last two matter more than the absences. A `files` list that accidentally
// excludes the generated code, or the provenance index, produces a tarball that
// installs cleanly and then fails — and that failure happens in a customer's CI
// rather than in this repository's suite. So the tarball is asserted to contain
// all six services, the JavaScript, the declarations, and specs/index.json.
//
// `specs/index.json` specifically: it is six kilobytes, it is the only record of
// which commit of which service this client was generated from, and it is the
// answer to "is this built from the document that describes the deployed
// service". Shipping it means a consumer can answer that question about the
// package they actually installed, offline, without a network and without this
// repository. That is the whole point of the vendoring, and a tarball without
// the index would throw it away.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { REPO_ROOT, readIndex } from '../scripts/lib/specs.mjs';

const execFileAsync = promisify(execFile);
const index = await readIndex();
const SERVICES = index.services.map((s) => s.service);
const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));

/** npm pack's own answer, in the shape npm gives it. */
let packed = null;

async function pack() {
  // NOT `--ignore-scripts`. `npm pack` runs `prepack`, which runs the build, and
  // letting that happen is the point: this is the real publish path, so the test
  // proves both that `dist/` is what npm would ship and that the `prepack` build
  // actually produces it. Suppressing the scripts here would make the test
  // assert against whatever `dist/` happened to be lying around, which is exactly
  // the stale-artifact failure the `prepack` hook exists to prevent.
  const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  // npm prints the JSON array last, after its own log lines. Taking everything
  // from the first `[` avoids depending on the log lines not being there.
  const start = stdout.indexOf('[');
  assert.ok(start >= 0, `npm pack produced no JSON: ${stdout}`);
  const parsed = JSON.parse(stdout.slice(start));
  assert.equal(parsed.length, 1, 'npm pack should describe exactly one tarball');
  return parsed[0];
}

describe('what npm would publish', () => {
  before(async () => {
    packed = await pack();
  }, { timeout: 120_000 });

  it('produces a tarball at all', () => {
    assert.ok(packed, 'npm pack returned nothing');
    assert.ok(packed.files.length > 0, 'the tarball would be empty');
    assert.equal(packed.name, manifest.name, 'npm packed a differently-named package');
    assert.equal(packed.version, manifest.version);
  });

  for (
    const [what, pattern] of [
      ['tests', /(^|\/)test(s)?\//],
      ['the vendoring and generation scripts', /(^|\/)scripts\//],
      ['the generator configuration', /openapi-ts\.config\./],
      ['TypeScript build configuration', /tsconfig.*\.json$/],
      ['CI definitions', /(^|\/)\.github\//],
      ['the gate script', /(^|\/)bin\//],
      ['installed dependencies', /(^|\/)node_modules\//],
      ['source maps', /\.map$/],
    ]
  ) {
    it(`contains no ${what}`, () => {
      const found = packed.files.map((f) => f.path).filter((p) => pattern.test(p));
      assert.deepEqual(
        found,
        [],
        `the tarball would ship ${what}: ${found.join(', ')}\n\n` +
          `package.json's "files" is: ${JSON.stringify(manifest.files)}`,
      );
    });
  }

  it('contains every shipped JavaScript and declaration file that exists on disk', () => {
    // The inverse of the absence checks, and the one that catches a `files` entry
    // that is too narrow. cafaye-rb's packaging_test.rb has the same check in the
    // same spirit — a library file that is not in the manifest is a file that is
    // not in the package.
    const distRoot = path.join(REPO_ROOT, 'dist');
    assert.ok(
      existsSync(distRoot),
      'dist/ does not exist even though `npm pack` ran `prepack`, which runs the build. ' +
        'Either the build failed silently or the prepack hook is not wired up. Run ' +
        '`npm run build` and read the error.',
    );

    const shipped = new Set(packed.files.map((f) => f.path));
    const expected = [];
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else if (/\.(js|d\.ts)$/.test(entry.name)) expected.push(`dist/${rel}`);
      }
    };
    walk(distRoot, '');

    assert.ok(expected.length > 50, `only ${expected.length} built files in dist/`);
    const missing = expected.filter((f) => !shipped.has(f));
    assert.deepEqual(
      missing,
      [],
      `${missing.length} built file(s) are not in the tarball, e.g. ${missing.slice(0, 5).join(', ')}`,
    );
  });

  for (const service of SERVICES) {
    it(`contains the generated client for ${service}`, () => {
      const shipped = packed.files.map((f) => f.path);
      assert.ok(
        shipped.includes(`dist/services/${service}/index.js`),
        `no dist/services/${service}/index.js in the tarball`,
      );
      assert.ok(
        shipped.includes(`dist/services/${service}/index.d.ts`),
        `no type declarations for ${service} in the tarball`,
      );
      assert.ok(
        shipped.includes(`dist/services/${service}/sdk.gen.js`),
        `no generated transport for ${service} in the tarball`,
      );
      assert.ok(
        shipped.includes(`dist/services/${service}/types.gen.js`),
        `no generated types for ${service} in the tarball`,
      );
    });
  }

  it('contains the provenance index, so a consumer can trace what this was built from', () => {
    const shipped = packed.files.map((f) => f.path);
    assert.ok(
      shipped.includes('specs/index.json'),
      'specs/index.json is not in the tarball. It is the only record of which commit of ' +
        'which service this client came from, and shipping it lets a consumer answer that ' +
        'offline, about the package they installed. A vendored copy with no sha is a rumour; ' +
        'a vendored copy with no index is a rumour nobody can repeat.',
    );
  });

  it('contains the documents a human needs and nothing else', () => {
    const shipped = packed.files.map((f) => f.path);
    for (const required of ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
      assert.ok(shipped.includes(required), `${required} is not in the tarball`);
    }
  });

  it('does not ship the vendored YAML, which is 300KB of duplicated specification', () => {
    // The documents are large, they belong to the service repositories, and their
    // content is fully represented by the generated types. Shipping them would
    // triple the install for a self-hoster and create a second copy that could
    // disagree with the service's own. The index travels instead, and it is
    // enough to fetch the right revision if somebody wants the document itself.
    const specs = packed.files.map((f) => f.path).filter((p) => p.startsWith('specs/'));
    assert.deepEqual(specs, ['specs/index.json'], `unexpected files under specs/: ${specs.join(', ')}`);
  });

  it('declares the entrypoints it actually ships', () => {
    // Every path in `main`, `types` and `exports` must be in the tarball. A
    // manifest that points at a file npm did not pack produces a package that
    // installs and then cannot be imported, and the error says nothing about
    // packaging.
    const shipped = new Set(packed.files.map((f) => f.path));
    const referenced = new Set();

    const walk = (value) => {
      if (typeof value === 'string') {
        if (value.startsWith('./') && !value.includes('*')) referenced.add(value.slice(2));
      } else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(manifest.main);
    walk(manifest.types);
    walk(manifest.exports);

    const missing = [...referenced].filter((p) => !shipped.has(p));
    assert.deepEqual(
      missing,
      [],
      `package.json points at ${missing.join(', ')}, which npm did not pack. ` +
        `Either the build did not produce it or "files" excludes it.`,
    );
  });
});
