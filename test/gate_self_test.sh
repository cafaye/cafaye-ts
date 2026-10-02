#!/usr/bin/env bash
#
# gate_self_test.sh — cafaye-ts's proof that its gate declaration is load-bearing.
#
#   bash test/gate_self_test.sh
#
# WHY THIS IS HERE. `gate.yml` is a claim: "this is the gate, this is what it
# needs from the machine, and this is the line in the log that proves it ran". A
# claim nobody has tried to break is a comment. This script copies THIS
# repository to a throwaway directory once per case, breaks exactly one thing in
# the copy, and asserts that core's checker goes red AND names the finding that
# case was written for. Naming the finding is the part that matters: "something
# went red" could be any check at all, including an incidental one, and a
# self-test that accepts any red has stopped testing the thing it names.
#
# IT IS NOT PART OF `mise run prime`, AND THE REASON IS STRUCTURAL RATHER THAN
# STYLISTIC. `bin/prime` runs `npm test`, which globs `test/**/*.test.mjs`. If
# this file ran inside the gate, the gate would run the checker, the checker
# would run the gate, and a gate that verifies itself by running itself
# terminates — and the termination is all it would have proved. So it is a shell
# script whose name the glob cannot match. core's own gate.yml says the same
# about `harness/tests/gate_self_test.sh`, for the same reason.
#
# THE CONTROL COMES FIRST, AND IT IS NOT A FORMALITY. Fourteen reds against a
# repository that was already red prove nothing, so case 0 runs the checker over
# an UNMODIFIED copy — the static half, and then `--prove`, which really runs the
# gate — and requires the static half to be green. It also pins the warning count,
# because the two warnings this declaration produces are deliberate (both are
# `gate.requirement-unproven`: two claims about the machine rather than about the
# repository) and a requirements block that quietly grows a third unproven claim
# should be a decision rather than a diff nobody read.
#
# THE PROVING HALF OF THE CONTROL NO LONGER REQUIRES EXIT 0, and that is the one
# behaviour change in this file. `test/customer-capability.test.mjs` carries two
# tests that fail ON PURPOSE — ten `identity` tenancy operations the service
# serves and documents nowhere, and five OpenID Connect operations documented in a
# SECOND document this repository does not vendor. `node --test` exits nonzero, so
# `bin/prime` is nonzero and `gate.nonzero` fires. That is the ordinary mechanism
# doing the ordinary thing, and it is what `gate.yml`'s new `suite-pass` comment
# describes. What the control now requires instead is STRONGER where it counts:
# both count-bearing proofs must have been satisfied — the floor found a `# pass`
# line and cleared it, `# skipped 0` was found — and `gate.nonzero` must be the
# ONLY finding that fired. A control that only checked the exit code would accept
# a run in which the proofs never appeared at all, which is case 10 under a
# different name.
#
# THE THIRTEEN BREAKAGES
#   Static — the declaration against the tree, nothing run:
#     1. entrypoint names a file that is not there
#     2. command names a file that is not there
#     3. the mise task resolves to a DIFFERENT file than the entrypoint — the
#        two-gates-in-one-repository failure, where `mise run prime` and
#        `bin/prime` quietly disagree and the local gate and CI's gate are
#        different gates wearing one name
#     4. the named mise task is not in mise.toml
#     5. ci.workflow names a workflow this repository does not have
#     6. ci.invokes names an argv the workflow never runs. A declaration and a
#        workflow are two files in two languages describing one gate, and nothing
#        else notices when they part.
#     7. a requirement is satisfied by a repository file that is not there — the
#        pointer-to-a-page-that-does-not-exist this format replaced
#     8. an undeclared key, which core's schema refuses with
#        `additionalProperties: false`
#     9. no ci block at all — a WARNING, and case 9 asserts the exit code is
#        still 0. A checker that turned a warning into a failure would be red on
#        a laptop and green on CI.
#   Proving — the gate really runs, so each of these costs a gate run:
#    10. a proof pattern that matches nothing the gate prints. The pattern is
#        still a valid regular expression and the declaration is still well
#        formed; it is simply a claim about a line this repository never prints.
#    11. the floor raised above the suite's real count — the ratchet, and the
#        breakage that says the floor is a number somebody read off a log rather
#        than a number somebody chose. The number is READ from gate.yml rather
#        than written here, which is a fix: this case used to `edit 'minimum:
#        187' 'minimum: 188'` and had been silently stale since cafaye-ts-01b
#        raised the floor to 201.
#    12. `npm test` pointed at a glob that matches no file. THE ONE THAT IS NOT
#        STRING MATCHING, and it is measured rather than assumed: on node 22.19.0
#        `node --test` against an empty glob prints `# pass 0` and EXITS 0. That
#        is the cafaye-rb defect — a suite that filtered itself out of existence,
#        a green, and a build number on it — reproduced in TypeScript. This case
#        asserts `gate.floor` fires AND that `gate.nonzero` does NOT, because the
#        gate exited zero. A checker that had only noticed the exit code would
#        have called this green. Unaffected by the two deliberate failures: a
#        glob that matches nothing runs no tests at all, capability findings
#        included.
#    13. one test marked `.skip`. `# tests` goes up and `# pass` STAYS exactly
#        where it was, so the floor does not move and the only proof that catches
#        it is the skip one. This case asserts the `suite-no-skip` proof fails and
#        that `gate.floor` does not. Its `gate.nonzero` clause is GONE, and the
#        removal is explained at the case: the gate no longer exits zero, and a
#        clause requiring a zero exit could not be kept by any honest means.
#
# ONE FIX THIS SCRIPT NEEDED AND DID NOT KNOW IT NEEDED
#
# Every copy runs the whole suite, and the suite's `test/spec-drift.test.mjs`
# resolves the six cafaye checkouts RELATIVE TO THE REPOSITORY IT IS RUNNING IN.
# A copy under `$TMPDIR` has no `../` and no `../../cafaye`, so the drift test
# skipped eleven times — which failed `suite-no-skip` AND dropped `# pass` by
# eleven, which failed the floor. Both fired on the control, and the self-test
# reported a red that had nothing to do with `gate.yml`. See the `WORKSPACE`
# block below for the fix and for the measurement.
#
# WHAT IT IS NOT
#
# Not exhaustive mutation testing, and not a claim that the suite is complete.
# Thirteen specific things are proved, plus the control. It says nothing about
# whether the 208 passing tests touched the code they name — core's
# harness/gate_findings.json names that hole under `notEnforced`, and so does the
# comment at the end of gate.yml.
#
# IT DEPENDS ON A cafaye/core CHECKOUT, and it says so rather than skipping. The
# checker is not vendored here: a second copy of it would be a second YAML
# dialect, which is the drift core exists to end. Point CAFAYE_CORE at one, or
# leave it unset and let this script find ../core. If it cannot, this exits 2 —
# never 0. A self-test that could not run and reported a pass would be the exact
# defect it exists to catch.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cafaye-ts-gate-self-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

passed=0
failed=0
skipped=0
failures=""

# --------------------------------------------------------------------------
# core's checker
# --------------------------------------------------------------------------

# CAFAYE_CORE wins; then a core checkout beside or above this repository, which
# is where the cafaye workspace keeps it. Two candidates rather than one because
# this repository is worked in both as cafaye-ts and as a git worktree named
# cafaye-ts-<packet>, and both layouts sit in the same parent directory.
CORE="${CAFAYE_CORE:-}"
if [ -z "$CORE" ]; then
  for candidate in "$ROOT/../core" "$ROOT/../../core"; do
    if [ -x "$candidate/harness/bin/gate-check" ]; then
      CORE="$(cd "$candidate" && pwd)"
      break
    fi
  done
fi

if [ -z "$CORE" ] || [ ! -x "$CORE/harness/bin/gate-check" ]; then
  {
    echo "gate_self_test: cafaye/core's checker was not found."
    echo "  Looked for harness/bin/gate-check under \$CAFAYE_CORE, $ROOT/../core"
    echo "  and $ROOT/../../core. This script does not vendor the checker: a second"
    echo "  copy would be a second YAML dialect."
    echo "  Set CAFAYE_CORE to a core checkout and run it again."
    echo "  Exiting 2, not 0: a self-test that could not run is not a passing one."
  } >&2
  exit 2
fi
GATE_CHECK="$CORE/harness/bin/gate-check"

# THE WORKSPACE, handed to every copy. This is a fix, and the defect it fixes was
# this repository's own — found while writing the sibling
# `test/capability_self_test.sh`, and not by anything that was looking for it.
#
# `test/spec-drift.test.mjs` resolves the six cafaye checkouts by looking at
# `$CAFAYE_WORKSPACE`, then `../`, then `../../cafaye` RELATIVE TO THE REPOSITORY
# IT IS RUNNING IN. In the real worktree that finds the cafaye directory and
# verifies all six, so `# skipped` is 0 and `gate.yml`'s `suite-no-skip` proof is
# satisfied. In a copy under `$TMPDIR` there is no `../` and no `../../cafaye`, so
# the drift test SKIPS eleven times — and then two things break at once: the
# `suite-no-skip` proof fails, and `# pass` drops by eleven, so the `suite-pass`
# floor fails too.
#
# Both of those fired here, on a control that was supposed to be green, and the
# result was a self-test reporting `control: the gate really runs and the proofs
# appear` as RED against an unmodified repository. Nothing was wrong with the
# declaration; the copy simply could not see the fleet. Measured on this tree
# before the fix: `# tests 210  # pass 188  # fail 10  # skipped 11` for a copy of
# a repository whose own suite prints 208 passing and 0 skipped. A self-test that
# cannot get its own fixture right is not a self-test, and it had been reporting
# that shape for as long as it existed.
#
# The resolution imports `scripts/lib/workspace.mjs` — the one implementation this
# repository has — rather than re-deriving `../` and `../../cafaye` here, because a
# second copy of the search order is a second answer to "where is the workspace"
# and that is the exact drift that module's own header exists to prevent.
WORKSPACE="$(node --input-type=module -e "
  import { readIndex } from 'file://$ROOT/scripts/lib/specs.mjs';
  import { resolveWorkspace } from 'file://$ROOT/scripts/lib/workspace.mjs';
  const { dir } = await resolveWorkspace(await readIndex(), process.env.CAFAYE_WORKSPACE);
  process.stdout.write(dir ?? '');
" 2>/dev/null)"
if [ -n "$WORKSPACE" ]; then
  export CAFAYE_WORKSPACE="$WORKSPACE"
else
  {
    echo "gate_self_test: no cafaye workspace beside this checkout, so every copy's drift test"
    echo "  will SKIP eleven times and BOTH count-bearing proofs in gate.yml will fail in the"
    echo "  copies — the floor, because # pass drops, and suite-no-skip. The static cases below"
    echo "  still work; the proving ones cannot, and a self-test that reports those reds as"
    echo "  findings about gate.yml is reporting a fact about its own fixture."
    echo "  Point CAFAYE_WORKSPACE at a directory holding the six checkouts and run it again."
  } >&2
fi

PY=""
for candidate in python3 python3.13 python3.12 python3.11 python; do
  if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
done
if [ -z "$PY" ]; then
  echo "gate_self_test: no python on PATH; the file-editing helpers need one." >&2
  exit 2
fi

# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

# copy <name> — a fresh, SELF-CONTAINED copy of this repository.
#
# `git init` is not incidental. Eight tests in this suite read the repository's
# own index and object store — `git ls-files`, `git diff`, `git check-ignore`,
# `git update-index --assume-unchanged` — and a copy with no .git is RED on all of
# them for a reason that has nothing to do with the breakage under test. Copying
# this worktree's own .git POINTER FILE instead is worse than useless: those
# tests would read the original worktree through the back door, and a breakage
# would appear not to have happened. So the copy is a real repository, committed
# once, and the green every case starts from is the control's green rather than
# an accident of where .git happened to point.
copy() {
  local name="$1"
  local dst="$WORK/$name"
  # `local a=$1 b=$a` is a bug in bash: every word on the line is expanded before
  # any of them is assigned, so `$a` is unbound and `set -u` kills the function.
  # It is also a bug with teeth — `dst` is the argument of an `rm -rf`, and an
  # unbound one is `/`. Hence the guard, and hence the separate lines.
  if [ -z "$dst" ] || [ "$dst" = "/" ] || [ ! -d "$WORK" ]; then
    echo "  FATAL: refusing to build a copy at '$dst'." >&2
    exit 2
  fi
  rm -rf "$dst"
  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude '.git' --exclude 'node_modules' "$ROOT/" "$dst/"
  else
    (cd "$ROOT" && tar -cf - --exclude '.git' --exclude 'node_modules' .) | (cd "$dst" && tar -xf -)
  fi
  git -C "$dst" init -q .
  git -C "$dst" -c user.email=gate-self-test@invalid -c user.name="gate self-test" add -A
  git -C "$dst" -c user.email=gate-self-test@invalid -c user.name="gate self-test" \
    commit -q -m "the state gate.yml is checked against"
  printf '%s' "$dst"
}

# edit <file> <old> <new> — one textual breakage, and it FAILS LOUDLY if the tree
# has moved past it. A recipe whose anchor string no longer exists would leave the
# copy un-broken, the checker green, and this script reporting a red that was
# never caused by the case it names. A self-test that silently stops breaking
# anything is worse than no self-test at all.
edit() {
  if ! "$PY" - "$1" "$2" "$3" <<'PYEOF'
import sys

path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding="utf-8") as handle:
    body = handle.read()
if old not in body:
    sys.exit(f"this breakage no longer applies to {path}: {old!r} is not in it")
if body.count(old) != 1:
    sys.exit(f"{old!r} is ambiguous in {path}: {body.count(old)} matches, expected exactly 1")
with open(path, "w", encoding="utf-8") as handle:
    handle.write(body.replace(old, new, 1))
PYEOF
  then
    echo "  FATAL: a breakage recipe did not apply. This self-test is stale, and" >&2
    echo "  every result below it would be meaningless." >&2
    exit 2
  fi
}

# drop_key <file> <key> — remove a top-level YAML key and its indented body. For
# the one breakage that needs a whole block gone rather than a word changed.
drop_key() {
  if ! "$PY" - "$1" "$2" <<'PYEOF'
import re
import sys

path, key = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    lines = handle.readlines()
kept, skipping, dropped = [], False, 0
for line in lines:
    if skipping:
        if line.strip() and not line[0].isspace():
            skipping = False
        else:
            dropped += 1
            continue
    elif re.match(rf"^{re.escape(key)}:", line):
        skipping = True
        dropped += 1
        continue
    kept.append(line)
if not dropped:
    sys.exit(f"no top-level {key!r} key in {path}")
with open(path, "w", encoding="utf-8") as handle:
    handle.writelines(kept)
PYEOF
  then
    echo "  FATAL: drop_key could not remove the key. This self-test is stale." >&2
    exit 2
  fi
}

REPORT=""
LOG_DIR=""

# run_checker <repo> [prove] — run core's checker over one copy. `prove` adds
# --prove, which runs the copy's gate and writes its output to $LOG_DIR/gate.log.
# The checker's own report goes to a file rather than to this script's stdout,
# because the checker prints the gate's output path and not the output, and this
# script needs to grep findings without re-running anything.
run_checker() {
  local repo="$1"
  local mode="${2:-static}"
  # The same class of guard as `copy`, for the same reason: an empty argument
  # here would make the checker resolve its repository argument to the current
  # directory, and a self-test that silently checks the worktree instead of the
  # copy it broke proves nothing.
  if [ -z "$repo" ] || [ ! -d "$repo" ]; then
    echo "  FATAL: run_checker was handed '$repo', which is not a copy." >&2
    exit 2
  fi
  LOG_DIR="$WORK/logs/$(basename "$repo")"
  REPORT="$WORK/$(basename "$repo").report"
  mkdir -p "$LOG_DIR"
  if [ "$mode" = "prove" ]; then
    "$GATE_CHECK" --prove --log-dir "$LOG_DIR" "$repo" > "$REPORT" 2>&1
  else
    "$GATE_CHECK" --log-dir "$LOG_DIR" "$repo" > "$REPORT" 2>&1
  fi
}

# findings — the distinct gate.* ids the last report carried, space separated.
findings() {
  grep -o 'gate\.[a-z-]*:' "$REPORT" 2>/dev/null | sort -u | tr -d ':' | tr '\n' ' '
}

warn_count() {
  grep -c '^WARN ' "$REPORT"
}

record_pass() {
  passed=$((passed + 1))
  printf '  ok    %s\n' "$1"
}

record_fail() {
  failed=$((failed + 1))
  failures="$failures
  - $1 — $2"
  printf '  RED   %s — %s\n' "$1" "$2"
}

# expect_red <name> <finding> <absent-or-.> <repo> [prove]
#
# Exit 1 and the NAMED finding. `absent` names a finding that must NOT also fire,
# which is how a case states what KIND of defect it reproduced: case 12 passes
# only if `gate.nonzero` is absent, because the gate exited zero and anything
# else means the exit code caught it rather than the floor.
expect_red() {
  local name="$1" finding="$2" absent="$3" repo="$4" mode="${5:-static}"
  local code
  run_checker "$repo" "$mode"
  code=$?
  if [ "$code" -ne 1 ]; then
    record_fail "$name" "expected exit 1, got $code (2 means the check could not happen at all)"
    return
  fi
  if ! grep -q "FAIL $finding" "$REPORT"; then
    record_fail "$name" "expected $finding; the report carried: $(findings)"
    return
  fi
  if [ "$absent" != "." ] && grep -q "FAIL $absent" "$REPORT"; then
    record_fail "$name" "$absent also fired, so this case did not test what it names"
    return
  fi
  record_pass "$name"
}

# expect_green <name> <repo> — exit 0. For case 9 that is the whole assertion:
# a warning is a claim this machine could not settle, it is printed and counted
# separately, and it never moves the verdict.
expect_green() {
  local name="$1" repo="$2" code
  run_checker "$repo"
  code=$?
  if [ "$code" -ne 0 ]; then
    record_fail "$name" "expected exit 0, got $code: $(findings)"
    return
  fi
  record_pass "$name"
}

# --------------------------------------------------------------------------
# CASE 0 — the control. Unmodified, both halves.
# --------------------------------------------------------------------------

echo "gate_self_test: cafaye-ts — proof that gate.yml cannot be true and stay quiet"
echo "  checker:  $GATE_CHECK"
echo "  worktree: $WORK  (removed on exit)"
echo

control="$(copy control)"
run_checker "$control" static
code=$?
if [ "$code" -eq 0 ]; then
  record_pass "control: the UNMODIFIED declaration is green (static)"
else
  record_fail "control: the UNMODIFIED declaration is green (static)" "exit $code: $(findings)"
fi

warnings="$(warn_count)"
if [ "$warnings" -eq 2 ] && [ "$(grep -c 'WARN gate.requirement-unproven' "$REPORT")" -eq 2 ]; then
  record_pass "control: exactly 2 warnings, both the deliberate gate.requirement-unproven"
else
  record_fail "control: the warning count" \
    "expected 2 gate.requirement-unproven, found $warnings warnings: $(grep '^WARN ' "$REPORT" | cut -d: -f1 | tr '\n' ' ')"
fi

run_checker "$control" prove
code=$?
# THE GATE IS RED, AND THAT IS CORRECT. `test/customer-capability.test.mjs` carries
# two tests that fail on purpose — ten `identity` tenancy operations the service
# serves and documents nowhere, and five OpenID Connect operations documented in a
# SECOND document this repository does not vendor. `node --test` exits nonzero, so
# `bin/prime` is nonzero and `gate.nonzero` fires by the ordinary mechanism. See
# `scripts/lib/capability.mjs` for the operation list and REPORT-cafaye-ts-02b.md
# for which of the two findings is whose.
#
# So this control no longer requires exit 0 from the proving half, and the change
# is deliberate rather than a lowering. What it requires INSTEAD is stronger in
# the way that matters: both count-bearing proofs must have been SATISFIED — the
# floor found a `# pass` line and cleared it, and `# skipped 0` was found. A
# control that only checked the exit code would accept a run where the proofs
# never appeared at all, and that is finding 10's case: a different defect, under
# the same "something went red" name.
#
# A control that went quiet here instead would be the cafaye-rb shape once more: a
# tier whose failures stopped being read, reporting green.
if [ "$code" -ne 1 ]; then
  record_fail "control: the gate really runs, and the two reds are the ONLY reds" \
    "expected exit 1, got $code: $(findings); the gate's own output is in $LOG_DIR/gate.log"
elif ! grep -q '^# pass [0-9]' "$LOG_DIR/gate.log"; then
  record_fail "control: the gate really runs, and the two reds are the ONLY reds" \
    "the gate log carries no '# pass' line, so the suite-pass proof was never satisfied"
elif ! grep -q '^# skipped 0$' "$LOG_DIR/gate.log"; then
  record_fail "control: the gate really runs, and the two reds are the ONLY reds" \
    "the gate log does not carry '# skipped 0'"
elif ! grep -q 'FAIL gate.nonzero' "$REPORT"; then
  record_fail "control: the gate really runs, and the two reds are the ONLY reds" \
    "gate.nonzero did not fire, so the gate exited zero over a suite with two failing " \
    "tests — and that is the whole defect cafaye-ts-02b is about"
else
  # Anything beyond gate.nonzero firing would mean a second, unstated reason for
  # the red, and an unstated reason is the thing this whole file is against.
  extra="$(findings | tr ' ' '\n' | grep -vE '^gate\.(nonzero|requirement-unproven)?$' | tr '\n' ' ')"
  if [ -n "$extra" ]; then
    record_fail "control: the two reds are the ONLY reds" "these also fired: $extra"
  else
    record_pass "control: the gate really runs, both count proofs hold, and the only red is gate.nonzero"
    echo "         the gate reported: $(grep -E '^# (tests|suites|pass|fail|skipped) ' "$LOG_DIR/gate.log" | tr '\n' ' ')"
    echo "         and the gate is red on purpose — see REPORT-cafaye-ts-02b.md"
  fi
fi

# --------------------------------------------------------------------------
# static breakages — the declaration against the tree, nothing run
# --------------------------------------------------------------------------

echo
echo "-- static: the declaration against the tree"

repo="$(copy entrypoint-missing)"
edit "$repo/gate.yml" '  entrypoint: bin/prime' '  entrypoint: bin/prime-missing'
expect_red "1. entrypoint names a file that is not there" gate.entrypoint-missing . "$repo"

repo="$(copy command-missing)"
edit "$repo/gate.yml" '  command: [mise, run, prime]' '  command: [bin/prime-missing, run, prime]'
expect_red "2. command names a file that is not there" gate.command-missing . "$repo"

repo="$(copy task-unresolvable)"
edit "$repo/mise.toml" 'run = "./bin/prime"' 'run = "./scripts/generate.mjs"'
expect_red "3. the mise task resolves to a different file than the entrypoint" gate.task-unresolvable . "$repo"

repo="$(copy task-missing)"
edit "$repo/gate.yml" '  miseTask: prime' '  miseTask: nope'
expect_red "4. the named mise task is not in mise.toml" gate.task-missing . "$repo"

repo="$(copy ci-missing)"
edit "$repo/gate.yml" '  workflow: .github/workflows/ci.yml' '  workflow: .github/workflows/release.yml'
expect_red "5. ci.workflow names a workflow that is not here" gate.ci-missing . "$repo"

repo="$(copy ci-disagrees)"
edit "$repo/gate.yml" '  invokes: [bin/prime]' '  invokes: [mise, run, prime]'
expect_red "6. ci.invokes names an argv the workflow never runs" gate.ci-disagrees . "$repo"

repo="$(copy requirement-path-missing)"
edit "$repo/gate.yml" '        command: [npm, ci]' '        command: [scripts/no-such-installer.mjs]'
expect_red "7. a requirement is satisfied by a file that is not here" gate.requirement-path-missing . "$repo"

repo="$(copy schema)"
edit "$repo/gate.yml" '  timeoutSeconds: 900' '  timeoutSeconds: 900
  owner: nobody'
expect_red "8. an undeclared key" gate.schema . "$repo"

repo="$(copy ci-undeclared)"
drop_key "$repo/gate.yml" ci
expect_green "9. no ci block at all is a WARNING, and the exit code is still 0" "$repo"
if grep -q '^WARN gate.ci-undeclared' "$REPORT"; then
  record_pass "9b. ...and it is reported as gate.ci-undeclared, not swallowed"
else
  record_fail "9b. the warning is named" "the report carried no WARN gate.ci-undeclared line"
fi

# --------------------------------------------------------------------------
# proving breakages — each one really runs the gate
# --------------------------------------------------------------------------

echo
echo "-- proving: the gate runs, so each of these below costs a gate run"

repo="$(copy proof-missing)"
edit "$repo/gate.yml" "  match: '^# pass ([0-9]+)\$" "  match: '^# passed ([0-9]+) tests\$"
run_checker "$repo" prove
code=$?
if [ "$code" -ne 1 ]; then
  record_fail "10. a proof pattern that matches nothing the gate prints" "expected exit 1, got $code"
elif ! grep -q "FAIL gate.proof-missing" "$REPORT" || ! grep -q "proof 'suite-pass' never appeared" "$REPORT"; then
  record_fail "10. a proof pattern that matches nothing the gate prints" \
    "expected gate.proof-missing naming suite-pass; the report carried: $(findings)"
else
  record_pass "10. a proof pattern that matches nothing the gate prints"
fi

repo="$(copy floor)"
# The number is READ rather than written, and that is a fix rather than a style.
# This case used to `edit 'minimum: 187' 'minimum: 188'`, which was correct when
# 187 was the floor and went stale the first time the floor moved — cafaye-ts-01b
# raised it to 201 and the case did not notice, because a recipe whose anchor is
# missing exits 2 and the run had already been reported as passing up to that
# point. It is exactly the "a measurement that cannot fail is a memory" failure
# in a shell script: a stale anchor is loud, but only after everything above it
# has already been printed as green.
#
# Reading the live number and adding one keeps the case honest for as long as the
# floor exists, and `edit` still refuses if the key is not there at all — which is
# the failure worth being loud about, because it means the declaration has no
# floor to move.
#
# `grep -Eo` rather than `sed -n 's/…\+…/…/p'`, because BSD sed — which is what
# this runs on when the author is on a laptop — treats `\+` as a literal plus
# rather than as "one or more", so the GNU spelling reads as "this file has no
# floor" on macOS and passes on Linux. A self-test that only works on one of the
# two platforms its repository is developed on is a self-test with a hole in it,
# and the hole is exactly where this case's one job lives.
FLOOR="$(grep -Eo '^ *minimum: [0-9]+' "$ROOT/gate.yml" | head -1 | grep -Eo '[0-9]+$')"
if [ -z "$FLOOR" ]; then
  echo "  FATAL: gate.yml declares no numeric minimum, so there is no floor for case 11 to" >&2
  echo "  move. The declaration has changed shape and this case no longer applies." >&2
  exit 2
fi
edit "$repo/gate.yml" "      minimum: $FLOOR" "      minimum: $((FLOOR + 1))"
expect_red "11. the floor is above the suite's real count" gate.floor gate.proof-missing "$repo" prove

repo="$(copy empty-suite)"
edit "$repo/package.json" 'test/**/*.test.mjs' 'test/**/*.nothing-matches-this.test.mjs'
run_checker "$repo" prove
code=$?
if [ "$code" -ne 1 ]; then
  record_fail "12. npm test matches no file at all" "expected exit 1, got $code"
elif ! grep -q 'FAIL gate.floor' "$REPORT"; then
  record_fail "12. npm test matches no file at all" "expected gate.floor; the report carried: $(findings)"
elif grep -q 'FAIL gate.nonzero' "$REPORT"; then
  record_fail "12. npm test matches no file at all" \
    "gate.nonzero also fired, so the gate did NOT exit zero and this was not the false green it claims to be"
else
  record_pass "12. npm test matches no file: the gate EXITS 0, and the floor catches it"
  echo "         the gate's own log said: $(grep -E '^# (tests|suites|pass|skipped) ' "$LOG_DIR/gate.log" | tr '\n' ' ')"
fi

repo="$(copy one-skip)"
cat > "$repo/test/one-skip.test.mjs" <<'JSEOF'
// Injected by test/gate_self_test.sh, breakage 13. The body is unreachable and
// nothing is imported, so the only thing this file changes is the shape of the
// suite's summary: `# tests` goes up by one, `# pass` does not move, and
// `# skipped` goes up by one. That is the defect the second proof in gate.yml is
// for, and this file is how that proof is shown to be load-bearing rather than
// decorative.
import { test } from 'node:test';

test.skip('a test that stopped running and nobody noticed', () => {
  throw new Error('unreachable');
});
JSEOF
run_checker "$repo" prove
code=$?
if [ "$code" -ne 1 ]; then
  record_fail "13. one test silently skipped" "expected exit 1, got $code"
elif ! grep -q "FAIL gate.proof-missing" "$REPORT" || ! grep -q "proof 'suite-no-skip' never appeared" "$REPORT"; then
  record_fail "13. one test silently skipped" \
    "expected gate.proof-missing naming suite-no-skip; the report carried: $(findings)"
elif grep -q 'FAIL gate.floor' "$REPORT"; then
  record_fail "13. one test silently skipped" "gate.floor also fired, so the skip proof is not what caught this"
else
  # The `gate.nonzero` clause this case used to carry is GONE, and its removal is
  # the honest consequence of cafaye-ts-02b rather than a loosening. The clause
  # asserted "the gate exited zero, so nothing but the skip could have caught
  # this", and the gate no longer exits zero: `test/customer-capability.test.mjs`
  # has two failures that ARE the finding. There is no way to make the suite green
  # again from here — the OIDC half needs a second vendored document and a change
  # to the index shape — so the clause could not be kept by any honest means, and
  # removing it quietly is how a case stops testing.
  #
  # What is left is the half that is still exactly true and is the one the proof
  # exists for: a skip raises `# tests`, leaves `# pass` exactly where it was, and
  # moves no floor. `gate.floor` did not fire and `suite-no-skip` did. That is the
  # whole claim, and it does not need the exit code to make it.
  record_pass "13. one test silently skipped: caught by the skip proof, and by no other"
  echo "         the gate's own log said: $(grep -E '^# (tests|suites|pass|fail|skipped) ' "$LOG_DIR/gate.log" | tr '\n' ' ')"
  echo "         (gate.nonzero also fires, for the two capability findings — see REPORT-cafaye-ts-02b.md)"
fi

# --------------------------------------------------------------------------
# the tally: pass and fail and skip, always all three
# --------------------------------------------------------------------------

echo
echo "---------------------------------------------------------------"
printf 'gate_self_test: %d passed, %d failed, %d skipped\n' "$passed" "$failed" "$skipped"
if [ "$failed" -ne 0 ]; then
  echo "cases that stayed green, or went red for the wrong reason:"
  printf '%s\n' "$failures"
  echo "A green here would mean gate.yml is not load-bearing, which is the defect"
  echo "this file exists to catch."
  exit 1
fi
exit 0
