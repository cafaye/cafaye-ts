# REPORT — core-10, declaring cafaye-ts's gate

Worktree `cafaye-ts-worker-core-10-cafaye-ts`, branch `worker/core-10-cafaye-ts`.
Base: `c93d44e` (merge of `worker/cafaye-ts-02`). Nothing outside this worktree
was written; `cafaye/core` was read only.

## 1. The finding, first

**`bin/prime` is green on a node version this repository forbids.** Measured on
this tree, 2026-09-30, with node 22.12.0 — the version `mise` activates one
directory up, and an entirely ordinary thing to have on `PATH`:

```
$ python3 -c 'subprocess.run(["./bin/prime"], cwd=".")'     # PATH with node 22.12.0
==> node v22.12.0, npm 10.9.0
npm warn EBADENGINE   package: 'cafaye-ts@0.0.0',
npm warn EBADENGINE   required: { node: '>=22.19.0' },
npm warn EBADENGINE   current: { node: 'v22.12.0', npm: '10.9.0' }
npm warn EBADENGINE ... and the same for all five @hey-api packages ...
# pass 187
EXIT: 0
```

`package.json` declares `engines.node: ">=22.19.0"` and
`@hey-api/openapi-ts@0.99.0` declares `>=22.18.0`. **Neither is enforced by
`npm ci`.** Both are warnings, and `set -euo pipefail` cannot catch a warning,
so the gate exits 0 having run the whole suite on a toolchain the repository
never chose — which is the hazard `bin/prime`'s own header warns about ("installing
a toolchain as a side effect of running a gate is how a worktree ends up tested
against a version nobody chose"), arriving anyway, by the most obvious route.

This is why `gate.yml` declares `command: [mise, run, prime]` and **not**
`[bin/prime]`. `mise run prime` applies the pin from `mise.toml`, so the
`==> node v22.19.0` in the log is a number the declaration can stand behind. The
cost of that choice is stated in the file rather than hidden: a bare `command[0]`
is a PATH lookup, so `check_command` reports `gate.command-unknown` on a machine
without mise, and `entrypoint` is what carries the on-disk proof instead.

The second finding is smaller and shaped like the first: **two of the gate's
three steps print nothing when they succeed.** `npm ci` prints a package count;
`tsc --noEmit` prints *nothing*. Without a proof for it, `gate.proof` cannot see
the install or the type check at all.

## 2. What is in the commit

| File | What it is |
| --- | --- |
| `gate.yml` | the declaration — new, 147 lines, **31 of them declaration** and the rest comments explaining a judgement call |
| `test/gate_self_test.sh` | the red proof — new, 14 copies, 13 breakages, 17 assertions |
| `mise.toml` | one task added: `gate-self-test`. `[tasks.prime]` untouched |
| `AGENTS.md` | the Gates section now points at `gate.yml` and states the ratchet rule |
| `CHANGELOG.md` | an `Unreleased → Added` entry with the measurements |
| `REPORT-core-10.md` | this file |

`gate.yml` in full is 147 lines: 31 of declaration and 116 of comment or blank.
The comments are not decoration — every number in them was measured here, and the
two that could have been wrong were.

## 3. The declaration

| Field | Value | Why, in one line |
| --- | --- | --- |
| `command` | `[mise, run, prime]` | the measured finding above; applies `mise.toml`'s pin |
| `miseTask` | `prime` | `mise run prime` is the spelling `mise.toml`'s own header names |
| `entrypoint` | `bin/prime` | the file both `mise run prime` and CI's `./bin/prime` reach |
| `timeoutSeconds` | `900` | measured 45 s direct / 66 s through mise, warm; a cold runner pays npm ci first |
| `external.selfContained` | `false` | `npm ci` needs a registry and the gate needs a toolchain mise installed |
| `ci.workflow` | `.github/workflows/ci.yml` | the only workflow, and it runs `./bin/prime` |
| `ci.invokes` | `[bin/prime]` | CI runs the script, not the task — see §6 |

Three proofs, each with a distinct job:

| id | match | floor | what only it can catch |
| --- | --- | --- | --- |
| `suite-pass` | `^# pass ([0-9]+)$` | `187` | the suite lost tests, or ran nothing at all |
| `suite-no-skip` | `^# skipped 0$` | — | a test that stopped running while the count stayed put |
| `install-and-typecheck` | `^==> npm test$` | — | `npm ci` and `tsc --noEmit` said nothing, so nothing else would |

**The floor is 187 and 187 is what the suite reports.** A decrease-detector is the
only kind of floor worth having, so the number is the suite's real count, not a
round figure below it. It is raised in the same commit that adds a test.

### Why three proofs and not one

The second proof is not decoration, and case 13 of the self-test is how I know.
Injecting a single `test.skip` into a copy produces:

```
# tests 188   # suites 28   # pass 187   # skipped 1
```

`# pass` does **not** move. A suite that gained a test nobody runs is green, the
count a reader is scanning went up, and a floor keyed on that count sees nothing.
`# skipped 0` is the only line that moves with it. Measured, not assumed.

The first proof earns its floor from the same shape of failure, one level down:

```
# tests 0     # suites 0    # pass 0      # skipped 0
```

`node --test` pointed at a glob matching no file prints that and **exits 0**. That
is the cafaye-rb defect — a tier that filtered itself out of existence, a green,
and a build number on it — reproduced in TypeScript, and `0 < 187` is the only
thing standing between it and a badge.

### The two requirements

```
toolchain  mise install   → bin/prime exits 127 "prime: node is not on PATH"
network    npm ci         → the npm ci step exits 1 "npm error code ENOTCACHED"
```

Both `unmet` strings were **observed**, not predicted:

- `env -i PATH=/usr/bin:/bin bin/prime` → `prime: node is not on PATH. Run 'mise install' first`, exit 127.
- `npm ci --offline` against an empty cache → `npm error code ENOTCACHED`, exit 1, no `node_modules/`.

There is no third requirement. No database, no service, no credential, no
`filesystem` — a read-only checkout is pathological and `npm ci` fails on it
first, so declaring it would be a requirement with nothing behind it. The four
absences are named in the file so nobody goes looking for them.

One nuance worth stating because it is the reading this repository invites and it
is wrong: **`test/suite-is-offline.test.mjs` does not make the gate offline.**
That test keeps the *187 tests* offline, and it holds — they never fetch the six
OpenAPI documents. `npm ci` reaches the registry before any test runs.

## 4. The counts, and how they were read

Every gate invocation below was `bash` with `set -o pipefail` and
`${PIPESTATUS[0]}`. No `$?` after a pipe anywhere in this packet.

**The repository's own gate, with this change in place:**

```
$ mise run prime 2>&1 | tail -14
...
# tests 187
# suites 28
# pass 187
# fail 0
# cancelled 0
# skipped 0
# todo 0
PRIME EXIT=0
```

**187 passed, 0 skipped, 0 todo, 0 cancelled.** Nothing is hidden inside that
green. `git status --porcelain -- src/services` afterwards: 0 lines — the gate
left the generated tree byte-identical, which is the assertion CI makes.

**core's checker, static and proving:**

```
$ core/harness/bin/gate-check .
OK …: 0 failure(s), 2 warning(s) — warnings do not move the exit code   exit 0

$ core/harness/bin/gate-check --prove .
OK …: 0 failure(s), 2 warning(s) — warnings do not move the exit code   exit 0
```

**2 warnings, both `gate.requirement-unproven`**, one per requirement, because
`satisfy.command` for each is a bare name — a claim about *this machine*, which
the checker deliberately does not settle. That is the designed answer, and it is
the right one here. The self-test pins the count at exactly 2 so a requirements
block that quietly grows a third unproven claim has to be a decision.

**The self-test:**

```
gate_self_test: 17 passed, 0 failed, 0 skipped
```

The 17 are 3 control assertions + 13 breakages + 1 assertion that case 9's
warning was *named* rather than swallowed. `0 skipped` is a real 0: nothing in
this script can skip. The only way it declines to answer is by exiting **2**.

## 5. The thirteen breakages, and the control

`bash test/gate_self_test.sh` (≈4 min; four cases run the gate for real). Each
case copies this repository, `git init`s the copy, breaks exactly one thing, and
asserts the checker goes red **and names the finding that case was written for**.
Naming it is the assertion — "something went red" could be any check, and a
self-test that accepts any red has stopped testing the thing it names.

| # | breakage | finding | phase |
| --- | --- | --- | --- |
| 0 | **control, unmodified** | green, exactly 2 warnings, `--prove` runs the gate | static + prove |
| 1 | `entrypoint` names a file that is not there | `gate.entrypoint-missing` | static |
| 2 | `command` names a file that is not there | `gate.command-missing` | static |
| 3 | the mise task resolves to a **different file** than the entrypoint | `gate.task-unresolvable` | static |
| 4 | the named mise task is not in `mise.toml` | `gate.task-missing` | static |
| 5 | `ci.workflow` names a workflow this repository does not have | `gate.ci-missing` | static |
| 6 | `ci.invokes` names an argv the workflow never runs | `gate.ci-disagrees` | static |
| 7 | a requirement is satisfied by a file that is not there | `gate.requirement-path-missing` | static |
| 8 | an undeclared key | `gate.schema` | static |
| 9 | no `ci` block at all | `gate.ci-undeclared`, **exit code still 0** | static |
| 10 | a proof pattern that matches nothing the gate prints | `gate.proof-missing` | prove |
| 11 | the floor raised above the real count | `gate.floor` (and **not** `gate.proof-missing`) | prove |
| 12 | `npm test` pointed at a glob matching no file | `gate.floor`, and **`gate.nonzero` must be absent** | prove |
| 13 | one test marked `.skip` | `gate.proof-missing` on `suite-no-skip`, and **not** `gate.floor` | prove |

Cases 12 and 13 carry an `absent` assertion, and that is the part worth having:
both defects make the gate **exit 0**. A checker that had noticed only the exit
code would have called both of them green. Case 13 additionally asserts
`gate.floor` did *not* fire, which is what makes "the second proof earned its
place" a measurement rather than a claim.

**Why the copies need `git init`.** Eight tests in this suite read the
repository's own index and object store — `git ls-files`, `git diff`,
`git check-ignore`, `git update-index --assume-unchanged`. A copy with no `.git`
is **red on 8 tests** for reasons that have nothing to do with the breakage under
test; I measured that first. Copying this worktree's `.git` *pointer file* would
be worse than useless — those tests would read the original worktree through the
back door and a breakage would appear not to have happened. So the copy is a real
repository, committed once, and the green every case starts from is the control's
green.

**Two bugs I introduced and fixed, both worth recording.** `local name="$1"
dst="$WORK/$name"` is a bash bug: every word on the line is expanded before any
is assigned, so `$name` is unbound and `set -u` kills the function. It is a bug
with teeth, because `dst` is the argument of an `rm -rf` and an unbound one is
`/`. Nothing was deleted — the subshell died before the `rm`, and I checked `/`
before doing anything else — but the guard is now there and `run_checker` has the
same guard, for the same reason: an empty argument there makes the checker
resolve its repository argument to the current directory, and a self-test that
silently checks the worktree instead of the copy it broke proves nothing.

## 6. The judgement calls

**`command: [mise, run, prime]` rather than `[bin/prime]`.** §1. It costs a
`gate.command-unknown` warning on a machine without mise and buys a toolchain
requirement that is enforced rather than documented.

**`ci.invokes: [bin/prime]` while `command` is `mise run prime`.** Not an
inconsistency: CI has never run mise. It uses `actions/setup-node`, which puts an
explicit node on `PATH`, so CI pins the toolchain without mise at all. The schema
explicitly allows `invokes` to name a different spelling of the same entrypoint,
and the checker asks one question — does any `run:` body mention this argv — which
is "does CI run this gate", not "do the two agree character for character".

**CI's matrix runs node 24 as well as 22.19.0.** That is not a contradiction of
the toolchain requirement; a floor that has only ever been tested *at* the floor
is a floor nobody has checked anything above. CI proves both halves; the local
gate proves the pinned one, which is the one a local run can be trusted to have
used.

**`timeoutSeconds: 900` against a 45–66 s gate.** Deliberately slack. A floor
tight enough to catch a hang is tight enough to flake on somebody's first run,
and a flaky gate is a gate people stop reading. This is core's own reasoning and
the number is not tighter than it needs to be to be useful.

**`install-and-typecheck` is coupled to a human-editable `echo` in `bin/prime`.**
That is the accepted trade and it is the right direction of travel: reword the
echo and the declaration goes **red**, because at that point it can no longer see
two of the gate's three steps. Update both in one commit. I did not add a summary
line to `bin/prime` instead, because the brief forbids changing the gate.

**The self-test is not in `bin/prime`, and I did not add it to CI.** Structurally:
`bin/prime` runs `npm test`, which globs `test/**/*.test.mjs`, so a self-test in
the suite would mean the gate runs the checker, the checker runs the gate, and a
gate that verifies itself by running itself terminates. As for CI — see §7.

**No floor-enforcement test.** core has
`test_the_gate_floor_is_not_below_the_suite_core_claims_to_have`, which fails
until the floor is raised. cafaye-ts has no equivalent, and adding one here would
change the count it is asserting about, in the same commit, forever after. It is a
two-line test and it is worth adding — I left it out deliberately and named the
rule in `AGENTS.md` and in `gate.yml` instead of pretending a comment enforces it.

## 7. What I could not verify

**Not empty, and none of these could have worked from this worktree.**

1. **The self-test has never run on a GitHub runner.** Its copies run
   `command: [mise, run, prime]`, so the runner needs `mise` on `PATH`. This
   repository's CI installs node through `actions/setup-node` and has never
   installed mise. That is why I did **not** add a CI step: it would need a new
   third-party action or a global `npm i -g mise` to work, that is a supply-chain
   decision that is not mine to make in this packet, and I cannot test a CI job
   from here — shipping an untested job that breaks CI is worse than shipping no
   job. **This is the one loose end: `gate.yml` is not enforced in CI by
   anything.** The declaration is checked by `core`'s own suite and by anyone who
   runs `core/harness/bin/gate-check .`; nothing in *this* repository runs it.
   Whoever owns the CI decision should add a job that installs mise, runs
   `mise run gate-self-test` with `CAFAYE_CORE` pointed at a core checkout, and
   — separately, and this is the check the workflow text cannot do — runs
   `gate-check --prove`.

2. **`gate.command` on a machine without mise.** `check_command` reports
   `gate.command-unknown` for a bare name that is not on `PATH`. mise *is* on
   `PATH` here, so I observed the warning is absent rather than observing the
   warning. I am relying on the checker's documented behaviour, not on a
   measurement.

3. **Cold-cache timings.** Every gate run in this packet was on a warm npm cache
   and a warm `node_modules`. `timeoutSeconds: 900` is reasoned from the measured
   warm runs (45 s, 66 s) plus npm ci's own cost for 54 packages — not from a
   measured cold run. A first run on an empty runner is inside 900 s with room to
   spare, but I did not measure it.

4. **The registry-unreachable shape.** My `unmet` string for the network
   requirement is the one shape I observed: `ENOTCACHED`, from `npm ci --offline`
   against an empty cache. I tried to observe the genuinely-unreachable case with
   `--registry=http://127.0.0.1:9/` and npm answered with
   `npm error Exit handler never called!` — an npm-internal failure, not the code
   I expected — so I did **not** claim it. A real DNS failure's code
   (`EAI_AGAIN`/`ENOTFOUND`) is in the file only as the shape of the same
   requirement, not as an observation.

5. **The `filesystem` requirement I decided not to declare.** I could not
   demonstrate what "unmet" looks like for a read-only tree without making the
   checkout read-only, which is not something to do to somebody's worktree. Per
   the rule — a requirement I cannot demonstrate is worse than none — it is
   absent, and the four things that are *absent* are named in the file instead.

6. **Anything about the suite's correctness.** This packet changed no test and no
   line of `src/`. The 187 tests are as green as they were; whether they touch the
   code they name is `harness/gate_findings.json`'s `notEnforced`, and it is the
   same hole for this repository as for every other.

7. **A machine where the npm cache is cold *and* the registry is slow enough to
   exceed 900 s.** Untested and untestable here. If it ever fires it is a
   `gate.timeout` with a named remediation, which is the failure I would want.

## 8. Constraints

No sleeps. No raised retry counts. No loosened assertions — the only floors in
this packet are new ones, and the pre-existing 187-test floor in `AGENTS.md` is
unchanged. No token, key or JWT was logged or written anywhere; the checker's
design keeps the gate's own output out of its report, and the excerpts above are
the summary lines plus `npm`'s own engine warnings. Nothing was started or stopped
on this machine, no Docker was touched, no blanket cleanup was run, and nothing
outside this worktree was modified. The gate's behaviour was not changed to make
it pass — `bin/prime` is byte-identical.
