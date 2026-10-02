#!/usr/bin/env node
//
// What a customer can and cannot do through this client, right now.
//
//   npm run capability          # the answer, and a nonzero exit if it is "cannot"
//
// WHY A SCRIPT AND NOT ONLY A TEST
//
// `test/customer-capability.test.mjs` is the gate-visible half: it runs in
// `bin/prime`, it fails while the customer path is incomplete, and a reviewer
// reading the gate log sees the finding without asking for anything. This is the
// other half, and it exists because of what the test cannot do.
//
// A test's output is a verdict. Nobody planning a launch reads a verdict; they
// read a list — which operations, in what order, with what reason — and they read
// it while deciding what to do next. This prints that list, exits nonzero when
// anything is missing so it can be used in a script, and touches nothing: no
// network, no writes, no build beyond the one `tsc` the probe needs, and no
// service running.
//
// IT MEASURES BOTH SIDES, AND SAYS WHICH IS MISSING
//
// Each row is judged twice — against the vendored document and against the
// generated client — because the two failures have different owners. A document
// that does not describe an operation is identity's to fix and nothing here can
// conjure the method. A document that describes one the client does not have is
// this repository's, and it would be a generator or pipeline failure worth
// chasing immediately. Collapsing them would produce a list whose every line
// pointed at the wrong repository.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CUSTOMER_JOURNEY,
  documentOperations,
  evaluate,
  formatFindings,
  formatTable,
  probeNamespace,
} from './lib/capability.mjs';
import { REPO_ROOT, readIndex, specPathFor } from './lib/specs.mjs';
import { loadDist } from './lib/dist.mjs';

async function main() {
  const index = await readIndex();

  const documents = {};
  const clients = {};
  for (const entry of index.services) {
    const bytes = await readFile(specPathFor(entry));
    documents[entry.service] = documentOperations(bytes.toString('utf8'), {
      source: `${entry.service} (${entry.spec})`,
    });
    const namespace = await loadDist('services', entry.service, 'index.js');
    clients[entry.service] = probeNamespace(namespace);
  }

  const findings = evaluate({ documents, clients });
  const missing = findings.filter((f) => f.verdict !== 'present');

  process.stdout.write('cafaye-ts — the customer path, measured against this build\n\n');

  let step = null;
  for (const finding of findings) {
    if (finding.step !== step) {
      step = finding.step;
      process.stdout.write(`step ${step}: ${finding.title}\n`);
    }
    const mark = finding.verdict === 'present' ? 'ok  ' : 'MISS';
    const via =
      finding.verdict === 'present' ? finding.generatedAs : (finding.generatedAs ?? '—');
    process.stdout.write(
      `  ${mark}  ${String(finding.method).padEnd(6)} ${finding.path.padEnd(52)} ${via}\n`,
    );
  }

  process.stdout.write(
    `\n${findings.length - missing.length} of ${findings.length} required operations are ` +
      `callable through this client; ${missing.length} are not.\n`,
  );

  if (missing.length > 0) {
    process.stdout.write(`\n${formatFindings(findings, { detail: 'full' })}\n`);
    process.stdout.write(
      'The required set and the reason each entry is on it are in\n' +
        `  ${path.relative(process.cwd(), path.join(REPO_ROOT, 'scripts/lib/capability.mjs'))}\n` +
        'and the gate-visible check is\n' +
        '  test/customer-capability.test.mjs\n',
    );
    return 1;
  }

  process.stdout.write(`\n${formatTable(findings)}`);
  process.stdout.write(
    `\n${CUSTOMER_JOURNEY.length} steps, every required operation callable. This build can ` +
      'onboard a tenant and sign a user in.\n',
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`\ncapability failed: ${error.message}\n`);
    process.exit(1);
  });
