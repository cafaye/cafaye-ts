#!/usr/bin/env node
//
// Check the vendored documents against specs/index.json, and write nothing.
//
//   npm run verify:specs
//
// This is `scripts/vendor.mjs --verify-only` split out, because the two are
// asked for at different moments by different people:
//
//   `npm run verify:specs`  CI, a hook, or a reviewer who wants a one-line
//                           answer to "are the vendored documents still
//                           consistent with the index?"
//   `npm run vendor`        a maintainer who is deliberately about to change
//                           something, and wants the tool that changes it.
//
// The full offline check is also asserted by test/vendored-specs.test.mjs, so
// this script is a convenience rather than a gate of its own. It exits nonzero
// and names the service on the first inconsistency, which is what makes it
// useful in a pre-commit hook.

import { measureVendoredDocument, readIndex, SHA_PATTERN } from './lib/specs.mjs';

const FLEET = ['identity', 'billing', 'muse', 'darkroom', 'pantry', 'courier'];

async function main() {
  const index = await readIndex();
  const problems = [];

  const listed = index.services.map((s) => s.service).sort();
  if (JSON.stringify(listed) !== JSON.stringify([...FLEET].sort())) {
    problems.push(
      `the index lists [${listed.join(', ')}] but the fleet is [${FLEET.join(', ')}]. ` +
        `A service added to or removed from the fleet has to be reflected here, or the ` +
        `client silently stops covering it.`,
    );
  }

  let total = 0;

  for (const entry of index.services) {
    const where = `${entry.service} (${entry.spec})`;

    if (!SHA_PATTERN.test(entry.commit ?? '')) {
      problems.push(`${where}: commit is not a full 40-character sha: ${entry.commit}`);
      continue;
    }

    let measured;
    try {
      measured = await measureVendoredDocument(entry);
    } catch (error) {
      problems.push(`${where}: ${error.message}`);
      continue;
    }

    if (measured.sha256 !== entry.sha256) {
      problems.push(
        `${where}: contents do not match the index.\n` +
          `  index: ${entry.sha256}\n` +
          `  file:  ${measured.sha256}\n` +
          `  The vendored document was edited by hand, or it was vendored from a ` +
          `different commit. Never edit it — run \`npm run vendor\`.`,
      );
    }
    if (measured.operations !== entry.operations) {
      problems.push(
        `${where}: ${measured.operations} operations, index says ${entry.operations}.`,
      );
    }
    if (measured.paths !== entry.paths) {
      problems.push(`${where}: ${measured.paths} paths, index says ${entry.paths}.`);
    }
    if (measured.openapi !== entry.openapi) {
      problems.push(`${where}: OpenAPI ${measured.openapi}, index says ${entry.openapi}.`);
    }
    if (measured.infoVersion !== entry.infoVersion) {
      problems.push(
        `${where}: info.version ${measured.infoVersion}, index says ${entry.infoVersion}.`,
      );
    }
    if (entry.expectOperations != null && measured.operations !== entry.expectOperations) {
      problems.push(
        `${where}: ${measured.operations} operations, but expectOperations says ` +
          `${entry.expectOperations}. A document changed size under the client. If the ` +
          `change is intended, update expectOperations in specs/index.json in the same ` +
          `commit that vendors it.`,
      );
    }
    if (measured.operations === 0) {
      problems.push(`${where}: declares no operations at all.`);
    }

    total += measured.operations;
  }

  if (problems.length > 0) {
    process.stderr.write(`\n${problems.length} problem(s) with the vendored documents:\n\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n\n`);
    process.stderr.write(
      `A vendored document with no matching index entry is a specification nobody can ` +
        `trace, which is the thing specs/index.json exists to prevent.\n`,
    );
    return 1;
  }

  process.stdout.write(
    `specs/index.json and the ${index.services.length} vendored documents agree. ` +
      `${total} operations across the fleet.\n`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`\nverify-specs failed: ${error.message}\n`);
    process.exit(1);
  });
