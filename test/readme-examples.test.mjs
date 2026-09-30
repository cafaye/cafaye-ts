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
      // A type-only import is erased at runtime and cannot be checked this way.
      // Names starting with a capital are therefore skipped, and the types the
      // README names are checked by `npm run typecheck` instead — which compiles
      // the generated declarations, and is the only thing that can check a type.
      const runtimeNames = names.filter((n) => /^[a-z]/.test(n));
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
    const imports = new Set();
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

    for (const block of blocks) {
      const body = [];
      for (const line of block.split('\n')) {
        if (/^\s*import\s/.test(line)) imports.add(line.trim());
        else if (/^\s*export\s/.test(line)) {
          assert.fail(
            `the README has an \`export\` in a TypeScript example: ${line.trim()}. ` +
              `A reader copying an example that exports would be copying something ` +
              `that does not belong in an application.`,
          );
        } else body.push(line);
      }
      const text = body.join('\n');
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

    assert.ok(imports.size > 0, "the README's TypeScript examples contain no imports");

    const source = [
      '// Generated by test/readme-examples.test.mjs. Not committed; deleted in a finally.',
      ...[...imports],
      "import type { Problem, User } from 'cafaye-ts/services/identity';",
      ...bodies,
      '',
      // Named so the type-only import is used, and so a compiler configured with
      // noUnusedLocals does not reject the file for an unrelated reason.
      'export type __ReadmeTypes = [Problem, User];',
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

  it('states plainly that the hand-written client is not here yet', () => {
    // A README that oversells the package is a defect, not a style choice, and
    // the overselling here would be a reader looking for `new Cafaye(...)` and
    // not finding it. The brief for this packet is explicit that the wrapper is
    // somebody else's work.
    assert.match(
      readme,
      /There is no `Cafaye` class in this package yet/,
      'the README must say the hand-written client is not here, so nobody integrates against it',
    );
  });
});
