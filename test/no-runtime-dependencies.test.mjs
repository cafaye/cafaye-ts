// Property 2: the package has no runtime dependencies.
//
// MD6 requires zero, for a reason that is about self-hosting rather than about
// bundle size: a self-hoster who installs this client should be able to read one
// file and know exactly what arrived. A dependency tree is an audit that has to
// be delegated, and a transitive tree is an audit nobody can do at all.
//
// This file checks that claim three ways, and each catches something the others
// do not:
//
//   1. THE MANIFEST. `dependencies` is empty or absent. This is the claim a
//      README would make, asserted directly against package.json. It also fails
//      on `peerDependencies` and `optionalDependencies`, which are easy to treat
//      as "not really" dependencies: a peer is something the CONSUMER must
//      satisfy, so a client with a peer dependency has moved the problem into
//      someone else's install rather than solved it.
//
//   2. THE CODE. Every module specifier imported by every shipped `.ts` file is
//      relative or a Node builtin. This is the half that catches the interesting
//      failure: a `dependencies` block that is empty while the generated code
//      imports a package anyway. It cannot happen today — @hey-api/client-fetch
//      makes the generator COPY the client into the output rather than import it
//      — and that is exactly the kind of thing that silently stops being true
//      on a generator upgrade or a plugin change.
//
//   3. THE PINS. The installed generator is the pinned one, and the installed
//      typescript is a 5.x. The second is not about dependencies at all; it is
//      here because it is the same class of failure — a toolchain that drifted
//      from the pin without anybody deciding to change it — and because it is
//      the one that costs a broken build rather than a surprise dependency.
//
// WHY THE TYPESCRIPT CHECK IS HERE AND NOT IN A SEPARATE FILE
//
// Because `typescript` is a devDependency and this file is about devDependencies
// being the right place for tooling. It is worth stating in the same breath that
// it is EXACTLY pinned, and not with a caret:
//
//   @hey-api/openapi-ts@0.99.0 declares
//     peerDependencies: { typescript: ">=5.5.3 || >=6.0.0 || 6.0.1-rc" }
//
//   and TypeScript 7.0.2 — published, and npm's `latest` — satisfies that range.
//   With it installed the generator does not warn and does not degrade. It dies:
//
//     TypeError: Cannot read properties of undefined (reading 'AnyKeyword')
//       at node_modules/@hey-api/openapi-ts/dist/init-D6Y8JFUS.mjs:4017:21
//
//   which is the compiler API MD6 says TypeScript 7 removed. The declared peer
//   range does not protect you from this, and `npm install typescript` will
//   happily do it. Only an exact pin does. See AGENTS.md.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, builtinModules } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import ts from 'typescript';

import { listFiles } from '../scripts/lib/compare.mjs';
import { REPO_ROOT, readIndex } from '../scripts/lib/specs.mjs';

const require = createRequire(import.meta.url);
const index = await readIndex();
const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));


/**
 * Every module specifier the TypeScript compiler actually sees.
 *
 * NOT A REGEX, and finding that out is half the reason this function exists.
 *
 * The obvious implementation is `source.match(/from ['"]([^'"]+)['"]/g)`, and it
 * is wrong on this tree in two separate ways, both of which this repository
 * walked into:
 *
 *   1. The generated JSDoc is full of the specification's own prose, and that
 *      prose contains quoted fragments. identity's types.gen.ts has a doc comment
 *      reading `... distinguish "you have none" from "this is not your account".`
 *      A regex sees a `from "this is not your account"` and reports a dependency
 *      on a package named after a sentence.
 *
 *   2. src/index.ts contains a usage example in a doc comment — `import {
 *      createClient } from 'cafaye-ts/services/identity'` — which is a
 *      self-reference, not a dependency, and which a regex also reports.
 *
 * Both are false positives, and a test that cries wolf twice gets deleted, which
 * is worse than not having it. So the specifiers come out of the real parser
 * that `npm run typecheck` uses, which is already a pinned dependency of this
 * repository. Comments and string literals are not module specifiers, and the
 * compiler is the authority on that, not a pattern.
 */
function specifiersIn(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2023,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const found = [];

  const record = (specifier, node) => {
    if (typeof specifier === 'string' && specifier.length > 0) {
      found.push({ specifier, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
  };

  const visit = (node) => {
    // import ... from 'x'  /  export ... from 'x'
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier.text, node);
    }
    // import 'x'  (side-effect only)
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier.text, node);
    }
    // import('x')  — including the import type forms, which do not run but
    // would still be a dependency if they named a package.
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      record(node.arguments[0].text, node);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

/** Is this specifier a Node builtin? Node's own list, not a hand-written one. */
function isNodeBuiltin(specifier) {
  if (specifier.startsWith('node:')) return true;
  return builtinModules.includes(specifier);
}

describe('the manifest declares no runtime dependencies', () => {
  it('has an empty `dependencies`', () => {
    assert.deepEqual(
      manifest.dependencies ?? {},
      {},
      'MD6 requires zero runtime dependencies. A client a self-hoster installs should be ' +
        'auditable in one file, and a dependency tree is an audit they have to delegate. ' +
        'If a dependency is genuinely unavoidable, that is a decision to record in MD6, ' +
        'not one to make in a diff to package.json.',
    );
  });

  it('has no peer or optional dependencies either', () => {
    // A peer dependency is not "not a dependency". It is a requirement the
    // CONSUMER has to satisfy, which means the audit did not get smaller, it moved.
    for (const field of ['peerDependencies', 'optionalDependencies']) {
      assert.deepEqual(
        manifest[field] ?? {},
        {},
        `${field} is not empty. This moves the dependency question into the consumer's ` +
          `install rather than answering it here.`,
      );
    }
  });

  it('keeps the generator, the YAML parser and TypeScript in devDependencies', () => {
    // Stated explicitly rather than implied by the two tests above, because the
    // failure mode this guards is a well-meaning `npm install --save <tool>` by
    // somebody who did not read MD6.
    const dev = manifest.devDependencies ?? {};
    assert.deepEqual(
      Object.keys(dev).sort(),
      ['@hey-api/openapi-ts', '@types/node', 'js-yaml', 'typescript'],
      'the development toolchain changed. All four belong in devDependencies: the ' +
        'generator and TypeScript are build-time only, js-yaml reads the vendored ' +
        'documents at build time, and @types/node is types for the build scripts.',
    );
  });
});

describe('the shipped code imports nothing that is not already here', () => {
  it('every module specifier the compiler sees in src/ is relative or a Node builtin', async () => {
    const files = (await listFiles(path.join(REPO_ROOT, 'src'))).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length > 0, 'no TypeScript under src/ — nothing to check');
    assert.ok(
      files.length > 50,
      `only ${files.length} TypeScript files under src/. The generated tree is supposed to be ` +
        `here and committed; a count this low means the tree was gitignored or not generated.`,
    );

    const offenders = [];
    let seen = 0;

    for (const file of files) {
      for (const { specifier, line } of specifiersIn(path.join(REPO_ROOT, 'src', file))) {
        seen += 1;
        const relative = specifier.startsWith('./') || specifier.startsWith('../');
        if (!relative && !isNodeBuiltin(specifier)) {
          offenders.push(`src/${file}:${line}  ${specifier}`);
        }
      }
    }

    // A sanity check on the extractor itself, because a specifier scanner that
    // finds nothing has silently stopped being a scanner. It found 97 import
    // declarations when this was written; finding fewer than a hundred across
    // this tree means the AST walk broke, not that the tree got simpler.
    assert.ok(
      seen > 100,
      `the module-specifier scan found only ${seen} specifiers across ${files.length} files. ` +
        `That is the scanner being wrong, not the tree being dependency-free.`,
    );

    assert.deepEqual(
      offenders,
      [],
      `non-relative, non-builtin module specifiers:\n${offenders.join('\n')}\n\n` +
        'This is the assertion that keeps `dependencies: {}` honest. The generated ' +
        'transport runs on the platform `fetch` because @hey-api/client-fetch makes the ' +
        'generator COPY the client into the output rather than import a package. Switching ' +
        'to a different client in openapi-ts.config.ts, or adding a plugin that imports ' +
        'one, would put a runtime dependency here without touching package.json.',
    );
  });

  it('resolves every module specifier to a file inside this repository', async () => {
    // The same property asked through the module RESOLVER rather than through the
    // syntax, and it is a genuinely different question: a `.js` specifier that
    // resolves to nothing is not a dependency, but it is a package that does not
    // work, and finding out at a consumer's install is the worst place to find
    // out. This asserts the whole graph closes inside src/ and the Node builtins.
    const files = (await listFiles(path.join(REPO_ROOT, 'src'))).filter((f) => f.endsWith('.ts'));
    const unresolved = [];

    for (const file of files) {
      const absolute = path.join(REPO_ROOT, 'src', file);
      for (const { specifier, line } of specifiersIn(absolute)) {
        if (isNodeBuiltin(specifier)) continue;
        const target = path.resolve(path.dirname(absolute), specifier);
        // The generated code uses `.js` specifiers, because moduleResolution is
        // NodeNext. Under NodeNext that is correct: the emitted JavaScript is what
        // runs, and tsc rewrites nothing. So the file to look for is the `.ts`
        // source, and the sibling shapes NodeNext allows.
        const candidates = [
          target,
          target.replace(/\.js$/, '.ts'),
          target.replace(/\.js$/, '.d.ts'),
          path.join(target, 'index.ts'),
        ];
        if (!candidates.some((c) => existsSync(c))) {
          unresolved.push(`src/${file}:${line}  ${specifier}`);
        }
      }
    }

    assert.deepEqual(
      unresolved,
      [],
      `module specifiers that resolve to nothing:\n${unresolved.join('\n')}\n\n` +
        'Every relative specifier in the generated tree must resolve inside this ' +
        'repository. An unresolvable one is a package that installs and then fails.',
    );
  });
});

describe('the build toolchain is the pinned one', () => {
  it('has the pinned generator installed, at the version the index records', () => {
    const installed = require('@hey-api/openapi-ts/package.json').version;
    assert.equal(
      installed,
      index.generator.version,
      `the installed @hey-api/openapi-ts is ${installed}, but specs/index.json records ` +
        `${index.generator.version}. One of them is wrong. If the pin moved, that is a ` +
        `decision: update both in the same commit, and expect regeneration.test.mjs to ` +
        `report exactly what the new version changed.`,
    );
  });

  it('pins the generator exactly, with no range', () => {
    const spec = manifest.devDependencies['@hey-api/openapi-ts'];
    assert.equal(
      spec,
      index.generator.version,
      'the generator must be pinned to an exact version. A caret range on a code generator ' +
        'is a public API change waiting for a patch release, which is the exact lock-in ' +
        'MD6 exists to prevent — the failure mode it cites is Stainless, a commercial ' +
        'generator whose owner announced a wind-down and left every consumer holding a ' +
        'version range that no longer meant anything.',
    );
    assert.doesNotMatch(
      spec,
      /^[\^~><=*]/,
      `the generator specifier ${spec} is a range, not an exact version`,
    );
  });

  it('has TypeScript 5.x installed, because TypeScript 7 breaks the generator', () => {
    // Reproduced, not asserted from documentation. With typescript@7.0.2 installed
    // — a version that SATISFIES @hey-api/openapi-ts@0.99.0's own declared peer
    // range of ">=5.5.3 || >=6.0.0" — the generator crashes on startup with
    //
    //   TypeError: Cannot read properties of undefined (reading 'AnyKeyword')
    //     at node_modules/@hey-api/openapi-ts/dist/init-*.mjs
    //
    // before it reads a single document. MD6 calls TypeScript 7 a cliff and says
    // the fix is an open issue. It is. This test is the cliff's tripwire.
    const installed = require('typescript/package.json').version;
    assert.match(
      installed,
      /^5\./,
      `the installed typescript is ${installed}. @hey-api/openapi-ts@0.99.0's transformers ` +
        `use the TypeScript compiler API that TypeScript 7 removed, and with 7 installed the ` +
        `generator dies with a TypeError on ts.SyntaxKind.AnyKeyword before reading a ` +
        `document. The generator's declared peer range (>=5.5.3 || >=6.0.0) ACCEPTS 7.0.2, ` +
        `so the range does not protect you — only an exact pin to 5.x does. Change it ` +
        `deliberately, with a regeneration diff, never by running npm install typescript.`,
    );
  });

  it('pins TypeScript exactly, because the range is the cliff', () => {
    const spec = manifest.devDependencies.typescript;
    assert.match(
      spec,
      /^5\.\d+\.\d+$/,
      `typescript is pinned to ${spec}, which is not an exact 5.x version. A caret on ` +
        `typescript is a typecheck-behaviour change waiting to happen and, worse, is the ` +
        `exact form that let a TypeScript 7 install happen unnoticed.`,
    );
  });
});
