// The test suite's name for the built-package loader, and nothing else.
//
// The implementation moved to `scripts/lib/dist.mjs` when `scripts/capability.mjs`
// needed the same thing: both the gate-visible check and the human-facing script
// have to ask what the BUILT client can do, and a script reaching into `test/`
// for its own loader would make the test directory a library the shipped scripts
// depend on. `scripts/lib/` is where this repository keeps what a script and a
// test both need — `specs.mjs` and `workspace.mjs` are already there.
//
// This file stays so that the seven test files importing it change nothing, and
// so a reader opening a test file still sees a path that reads as test
// infrastructure. It is a re-export and deliberately contains no logic: a second
// copy of `ensureBuilt` would be a second answer to "is `dist/` current", and
// that is the question the move was made to keep singular.

export { distPath, ensureBuilt, loadDist, REPO_ROOT } from '../../scripts/lib/dist.mjs';
