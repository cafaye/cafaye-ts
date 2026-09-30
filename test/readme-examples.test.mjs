// The README's examples are executed, not trusted.
//
// cafaye-rb has `test/readme_example_test.rb` and this is the same idea in this
// repository's idiom. It is here because the first draft of README.md documented
// an import that does not exist:
//
//   import { createClient } from 'cafaye-ts/services/identity';
//
// The service entrypoint exports the SDK functions and the types. `createClient`
// lives one directory deeper, at `cafaye-ts/services/identity/client`, and the
// difference is invisible unless you install the packed tarball into a scratch
// project and import it — which is how it was found, and which is what this
// file now does on every run of the suite.
//
// A README is the first thing a self-hoster reads and the last thing anybody
// tests. A wrong import in one is a support ticket, and the failure lands in
// their project rather than in this repository's CI.
//
// HOW IT WORKS
//
// It resolves the documented specifiers against the BUILT package rather than
// against `src/`, because `src/` is not what anyone installs and it answers
// questions the consumer's runtime will not. `npm pack` already built `dist/`
// in test/package-contents.test.mjs; this file imports the real entrypoints,
// checks the documented exports exist, and exercises the factory far enough to
// prove the configured base URL is the one that comes back out.
//
// The specifiers are read out of README.md rather than hardcoded, so a documented
// import that stops resolving fails here instead of silently drifting from the
// prose. A hardcoded list here would be a second copy of the documentation, and
// the whole repository is organised around not having those.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { before, describe, it } from 'node:test';

import { REPO_ROOT, readIndex } from '../scripts/lib/specs.mjs';

const index = await readIndex();
const SERVICES = index.services.map((s) => s.service);
const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const readme = await readFile(path.join(REPO_ROOT, 'README.md'), 'utf8');

/** Every `from '…'` specifier in a fenced ts block of the README. */
function documentedImports() {
  const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]);
  const specifiers = new Set();
  for (const block of blocks) {
    for (const match of block.matchAll(/from\s+'([^']+)'/g)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

/**
 * Resolve a subpath through package.json's `exports` map, properly.
 *
 * "Properly" means honouring `*`: the map declares `./services/*`, and
 * `cafaye-ts/services/identity/client` has to match it by SUBSTITUTING
 * `identity/client` for the `*` — not by trimming the last segment and then
 * hoping. The first version of this helper trimmed, which resolved
 * `cafaye-ts/services/identity/client` to `./services/identity` and then found
 * nothing; a test that gets the exports map wrong reports a working package as
 * broken, which is the more expensive of the two mistakes.
 */
function resolveExport(specifier) {
  const subpath = specifier === manifest.name ? '.' : `.${specifier.slice(manifest.name.length)}`;
  if (manifest.exports[subpath]) return manifest.exports[subpath];

  for (const [pattern, entry] of Object.entries(manifest.exports)) {
    const star = pattern.indexOf('*');
    if (star === -1) continue;
    const head = pattern.slice(0, star);
    const tail = pattern.slice(star + 1);
    if (!subpath.startsWith(head) || !subpath.endsWith(tail)) continue;
    if (subpath.length < head.length + tail.length) continue;
    const captured = subpath.slice(head.length, subpath.length - tail.length);
    const substitute = (value) =>
      typeof value === 'string' ? value.replace('*', captured) : value;
    if (typeof entry === 'string') return substitute(entry);
    return Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, substitute(v)]));
  }
  return null;
}

describe('the README documents things that work', () => {
  before(() => {
    assert.ok(
      existsSync(path.join(REPO_ROOT, 'dist', 'index.js')),
      'dist/ is not built. test/package-contents.test.mjs builds it via `npm pack`; ' +
        'run `npm run build` if you are running this file alone.',
    );
  });

  it('has TypeScript examples to check', () => {
    const specifiers = documentedImports();
    assert.ok(
      specifiers.length >= 3,
      `the README documents only ${specifiers.length} import(s). These examples are executed, ` +
        `so a README with none is untested documentation.`,
    );
  });

  it('every documented specifier resolves through package.json `exports`', () => {
    for (const specifier of documentedImports()) {
      assert.ok(
        specifier === manifest.name || specifier.startsWith(`${manifest.name}/`),
        `the README imports ${JSON.stringify(specifier)}, which is not this package ` +
          `(${manifest.name}) or one of its subpaths.`,
      );

      assert.ok(
        resolveExport(specifier),
        `the README imports ${JSON.stringify(specifier)}, which package.json's exports map ` +
          `does not define. Declared: ${Object.keys(manifest.exports).join(', ')}`,
      );
    }
  });

  it('every documented specifier actually imports, and exports what is named', async () => {
    // Imports go to the real built file the exports map points at, rather than
    // through the package name: the package is not installed inside itself, and
    // resolving through `exports` is exactly the resolution a consumer performs.
    const targetFor = (specifier) => {
      const entry = resolveExport(specifier);
      const target = typeof entry === 'string' ? entry : entry.default;
      return path.join(REPO_ROOT, target.replace(/^\.\//, ''));
    };

    // Which names each README example claims to import from where, read out of
    // the prose rather than restated here.
    const claimed = [];
    for (const block of [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1])) {
      for (const match of block.matchAll(/import\s+\{([^}]+)\}\s+from\s+'([^']+)'/g)) {
        const names = match[1]
          .split(',')
          .map((n) => n.trim().replace(/^type\s+/, ''))
          .filter(Boolean);
        claimed.push({ specifier: match[2], names });
      }
    }

    assert.ok(claimed.length > 0, 'no named imports found in the README examples');

    for (const { specifier, names } of claimed) {
      const target = targetFor(specifier);
      assert.ok(existsSync(target), `${specifier} maps to ${target}, which does not exist`);

      const module_ = await import(target);
      // A name is checkable at runtime when it is a value, and the two ways a
      // README writes one are a lower-case name (a function or constant) and a
      // class — `Cafaye`, `CafayeValidationError`. A class has an upper-case
      // first letter, so the original "skip anything capitalised as a type"
      // heuristic skipped exactly the thing this packet added, and reported that
      // the quickstart's only import had nothing to verify. A name that is neither
      // — capitalised and not exported at runtime — is assumed to be a type and is
      // left to the compile check below, which is where a misspelled name is
      // actually caught.
      const runtimeNames = names.filter(
        (n) => /^[a-z]/.test(n) || typeof module_[n] === 'function',
      );
      assert.ok(
        runtimeNames.length > 0,
        `the README's import from ${JSON.stringify(specifier)} names no runtime value, so ` +
          `this test has nothing to verify for it`,
      );
      for (const name of runtimeNames) {
        assert.ok(
          name in module_,
          `the README imports ${JSON.stringify(name)} from ${JSON.stringify(specifier)}, but ` +
            `that module does not export it. It exports: ` +
            `${Object.keys(module_).slice(0, 12).join(', ')}`,
        );
      }
    }
  });

  it('the documented createClient honours the base URL the README tells you to pass', async () => {
    // Not just "it exists". The point of the two-entrypoint arrangement is that
    // the consumer's own base URL is the one that comes back out — that is the
    // difference between a self-hoster's client and the pre-built one the
    // generator emits, and README.md makes a claim about it.
    const target = path.join(REPO_ROOT, 'dist', 'services', 'identity', 'client', 'index.js');
    assert.ok(existsSync(target), `no built client at ${target}`);

    const { createClient } = await import(target);
    assert.equal(typeof createClient, 'function');

    const client = createClient({ baseUrl: 'https://identity.example.com' });
    assert.equal(
      client.getConfig().baseUrl,
      'https://identity.example.com',
      'createClient did not keep the base URL the README tells a consumer to pass. ' +
        'A self-hoster depends on this: the documented default is the public SaaS URL, ' +
        'so a client that ignored the override would send production traffic to it.',
    );
  });

  it('documents an operation count for every service, and the counts are the measured ones', async () => {
    // The README carries a table of operation counts. A table is a claim, and a
    // stale table is worse than none: a reader comparing it against their own
    // service would conclude the client was wrong.
    for (const service of SERVICES) {
      const expected = index.services.find((s) => s.service === service);
      const row = readme.split('\n').find((line) => line.startsWith(`| \`${service}\``));
      assert.ok(row, `the README has no row for ${service}`);
      assert.match(
        row,
        new RegExp(`\\|\\s*${expected.operations}\\s*\\|`),
        `the README says a different operation count for ${service} than specs/index.json ` +
          `records (${expected.operations}). One of them is stale.`,
      );
    }
  });

  it('the README\'s TypeScript examples actually compile', async () => {
    // The half a runtime import cannot check, and it is not the smaller half.
    //
    // The first draft of this README read
    //     const user: User = await getCurrentUser({ client });
    // which type-checks as obviously wrong the moment you compile it: the
    // generated transport returns a RESULT ENVELOPE — `{ data, error, request?,
    // response? }` — not a bare `User`. A consumer copying that line gets an
    // error on their first call and a README to blame.
    //
    // The examples are written to a file inside the repository and compiled with
    // the project's own compiler settings. Inside the repository, not in a temp
    // directory, because `cafaye-ts/...` has to resolve: Node and TypeScript both
    // support a package referring to itself by name through its own `exports`
    // map, and that is exactly the resolution a consumer performs. A snippet
    // compiled outside the package tree would resolve nothing and pass for the
    // wrong reason.
    const { execFile } = await import('node:child_process');
    const { writeFile, rm } = await import('node:fs/promises');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]);
    assert.ok(blocks.length > 0, 'no TypeScript examples in the README to compile');

    // The blocks are illustrative fragments, and they are not independent: some
    // of them deliberately continue from the one above. The README's
    // `throwOnError: true` example says `const { data } = await getCurrentUser({
    // client, throwOnError: true })` using the `client` the PREVIOUS example
    // declared, which is how a person reads it and how a reader copies it.
    //
    // Meanwhile two of the blocks each declare their own `const client`, because
    // a reader is also meant to be able to start at either one. So the blocks are
    // neither fully independent nor one continuous module, and the
    // transformation has to work that out rather than assume either shape.
    //
    // The rule applied: hoist every import to one deduplicated header, then give
    // each block a fresh scope UNLESS it refers to a name an earlier block
    // declared and the block before it did not — in which case it continues that
    // block's scope. What is being checked is that the expressions type-check
    // against the real generated types, and a block scope checks that exactly as
    // well as top level does.
    const bodies = [];
    /** Names declared by the scope currently open, so continuations can be spotted. */
    let openScopeNames = new Set();
    let openScope = null;

    const declaredBy = (text) =>
      new Set(
        [...text.matchAll(/\b(?:const|let|var)\s+\{?\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
      );
    const referenced = (text) =>
      new Set([...text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1]));

    /**
     * Split a block into its import statements and its body.
     *
     * A MULTI-LINE import is the reason this is a function and not a one-liner.
     * The original matched `/^\s*import\s/` per line and hoisted only that line,
     * so
     *
     *     import {
     *       CafayeValidationError,
     *       isCafayeError,
     *     } from 'cafaye-ts';
     *
     * had its first line hoisted and its remaining three left in the body as bare
     * identifiers — and the probe failed to PARSE, with four errors that all said
     * "Identifier expected" and none that said what was wrong. A multi-line import is
     * not an exotic thing for a README to contain; it is what a formatter produces
     * for a long import list, which is exactly what the error-handling example has.
     */
    const splitImports = (block) => {
      const lines = block.split('\n');
      const importLines = [];
      const bodyLines = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^\s*import\s/.test(line)) {
          let statement = line;
          // A named import list may span lines; keep consuming until the `from`
          // clause closes it. Bounded by the end of the block, so a stray `import`
          // keyword in an example cannot swallow the rest of the file.
          while (!/\bfrom\b/.test(statement) && i + 1 < lines.length) {
            i += 1;
            statement += `\n${lines[i]}`;
          }
          importLines.push(statement);
        } else if (/^\s*export\s/.test(line)) {
          assert.fail(
            `the README has an \`export\` in a TypeScript example: ${line.trim()}. ` +
              'A reader copying an example that exports would be copying something ' +
              'that does not belong in an application.',
          );
        } else {
          bodyLines.push(line);
        }
      }
      return { statements: importLines, bodyLines };
    };

      // Hoisted imports, deduplicated by BINDING rather than by text.
    //
    // A `Set` of trimmed lines is not enough once the README imports the same
    // name twice — and it does, because each example is written to be readable on
    // its own and a reader is meant to be able to start at any of them. Two
    // examples both saying `import { Cafaye } from 'cafaye-ts';` produce two
    // identical lines, which a Set collapses, and one example saying
    // `import { Cafaye, CafayeValidationError, isCafayeError } from 'cafaye-ts';`
    // produces a line that overlaps the first, which a Set does not. Either way
    // the probe fails with `TS2300: Duplicate identifier 'Cafaye'`, which is a
    // property of the test's hoisting rather than of anything a reader would hit.
    //
    // So each hoisted line is reduced to the names it binds that are not already
    // bound from the same module, and dropped when that leaves nothing.
    const importLines = [];
  const boundNames = new Map();

  const hoist = (statement) => {
    const match = statement.match(
      /import\s+(type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/,
    );
    if (match === null) {
      // A bare `import 'x'` or a default import. Nothing in this README has one,
      // and passing it through is better than dropping it silently.
      importLines.push(statement);
      return;
    }
    const [, typeOnly, rawNames, module_] = match;
    const names = rawNames
      .split(',')
      .map((n) => n.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    const already = boundNames.get(module_) ?? new Set();
    const fresh = names.filter((n) => !already.has(n));
    for (const name of fresh) already.add(name);
    boundNames.set(module_, already);
    if (fresh.length === 0) return;
    importLines.push(
      `import ${typeOnly ?? ''}{ ${fresh.join(', ')} } from '${module_}';`,
    );
  };

  for (const block of blocks) {
    const { statements, bodyLines } = splitImports(block);
    for (const statement of statements) hoist(statement);
    const text = bodyLines.join('\n');
    const declares = declaredBy(text);
    const uses = referenced(text);

      // A continuation names something an open scope declared and does not
      // redeclare itself. Everything else gets its own scope, so the two
      // examples that both say `const client` do not collide.
      const continues = openScope !== null && [...uses].some((n) => openScopeNames.has(n) && !declares.has(n));

      if (continues) {
        openScope.push(text);
        openScopeNames = new Set([...openScopeNames, ...declares]);
      } else {
        openScope = [text];
        openScopeNames = declares;
        bodies.push(`{\n${openScope.join('\n')}\n}`);
      }
    }

    assert.ok(importLines.length > 0, "the README's TypeScript examples contain no imports");

    const source = [
      '// Generated by test/readme-examples.test.mjs. Not committed; deleted in a finally.',
      ...importLines,
      // The types the README's own prose promises a consumer can reach, injected
      // and ALIASED: cafaye-ts-01's README imported `Problem` and this one does
      // too, and an unaliased duplicate is `TS2300: Duplicate identifier`. They
      // are named so a compiler configured with noUnusedLocals does not reject the
      // file for an unrelated reason, and because the type-only imports are the
      // half a runtime import cannot check.
      "import type { Problem as __ReadmeProblem, User as __ReadmeUser } from 'cafaye-ts/services/identity';",
      "import type { Cafaye as __ReadmeCafaye } from 'cafaye-ts';",
      ...bodies,
      '',
      'export type __ReadmeTypes = [__ReadmeProblem, __ReadmeUser, __ReadmeCafaye];',
      '',
    ].join('\n');

    const probe = path.join(REPO_ROOT, 'readme-examples.probe.ts');
    try {
      await writeFile(probe, source, 'utf8');
      await execFileAsync(
        process.execPath,
        [
          path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
          '--noEmit',
          '--strict',
          '--module', 'nodenext',
          '--moduleResolution', 'nodenext',
          '--target', 'es2023',
          '--lib', 'es2023,dom',
          '--skipLibCheck',
          probe,
        ],
        { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 },
      );
    } catch (error) {
      assert.fail(
        "the README's TypeScript examples do not compile:\n\n" +
          `${error.stdout || ''}${error.stderr || ''}\n` +
          'A consumer who copies an example from the README gets this error in ' +
          'their project. Fix the README; do not loosen the compiler settings here.',
      );
    } finally {
      await rm(probe, { force: true });
    }
  });

  it('documents the wrapper as the front door, and the generated transport as the alternative', () => {
    // This test used to assert the opposite, and the assertion was the correct
    // statement of the world at the time: cafaye-ts-01 shipped the generated half
    // only, and a README that oversold the package is a defect rather than a style
    // choice. Packet cafaye-ts-02 landed `Cafaye`, so the claim is now that the
    // front door exists and that the two entrypoints are not confused — which is
    // the mistake a reader can actually make now, because both are exported from
    // the same package.
    assert.match(
      readme,
      /new Cafaye\(\{ baseUrl/,
      'the README must show the wrapper being constructed. A self-hoster reading this package ' +
        'is looking for `new Cafaye(...)` first, and not finding it is a support ticket.',
    );
    assert.match(
      readme,
      /import \{ Cafaye \} from 'cafaye-ts'/,
      'the README must show the import a consumer writes, resolving through the package name.',
    );
    assert.match(
      readme,
      /rawClient/,
      'the README must name the escape hatch, because an undocumented one is a trap: it hands ' +
        'back the untyped generated envelope and a reader who finds it by accident will not know ' +
        'that.',
    );
    assert.doesNotMatch(
      readme,
      /There is no `Cafaye` class in this package yet/,
      'the README still says the wrapper is absent. It is not.',
    );
  });

  it('documents the base-URL precedence, and never suggests a default', () => {
    // The README's table is a claim about behaviour, and the one claim that must
    // not rot is the last row. The scan is over the TABLE rather than the section,
    // because the prose under it says the opposite thing — "there is no default,
    // and no loopback fallback" — and a reader who finds that reassuring sentence
    // is being reassured, not misled. A table row offering one would mislead.
    for (const source of ['CAFAYE_BASE_URL', 'globalThis.location.origin', '**throws**']) {
      assert.ok(readme.includes(source), `the README does not document ${JSON.stringify(source)}`);
    }
    const table = readme
      .slice(readme.indexOf('## Where requests go'), readme.indexOf('## Credentials'))
      .split('\n')
      .filter((line) => line.trim().startsWith('|'))
      .join('\n');
    assert.ok(table.split('\n').length >= 7, 'the base-URL precedence table is not a table of six rows');
    assert.doesNotMatch(
      table,
      /localhost|127\.0\.0\.1/,
      'a row of the base-URL table offers a loopback address. Resolution never defaults to one.',
    );
  });

  it('documents that nothing is logged, because that is a guarantee and not a setting', () => {
    assert.match(
      readme,
      /emits no logs, no metrics and no telemetry|Nothing is logged, ever/,
      'the README must state that this package emits nothing. The credential-leak test proves it ' +
        'and a reader deciding whether to install a client in a regulated environment needs to ' +
        'know it without reading the suite.',
    );
  });
});
