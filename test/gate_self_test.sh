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
# THE CONTROL COMES FIRST, AND IT IS NOT A FORMALITY. Thirteen reds against a
# repository that was already red prove nothing, so case 0 runs the checker over
# an UNMODIFIED copy — the static half, and then `--prove`, which really runs the
# gate — and requires exit 0. It also pins the warning count, because the two
# warnings this declaration produces are deliberate (both are
# `gate.requirement-unproven`: two claims about the machine rather than about the
# repository) and a requirements block that quietly grows a third unproven claim
# should be a decision rather than a diff nobody read.
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
#        than a number somebody chose.
#    12. `npm test` pointed at a glob that matches no file. THE ONE THAT IS NOT
#        STRING MATCHING, and it is measured rather than assumed: on node 22.19.0
#        `node --test` against an empty glob prints `# pass 0` and EXITS 0. That
#        is the cafaye-rb defect — a suite that filtered itself out of existence,
#        a green, and a build number on it — reproduced in TypeScript. This case
#        asserts `gate.floor` fires AND that `gate.nonzero` does NOT, because the
#        gate exited zero. A checker that had only noticed the exit code would
#        have called this green.
#    13. one test marked `.skip`. `# tests` goes to 188 and `# pass` STAYS at
#        187, so the floor does not move and the gate is green — which is the
#        entire reason the declaration carries a second proof. This case asserts
#        the `suite-no-skip` proof fails and that `gate.floor` does not.
#
# WHAT IT IS NOT
#
# Not exhaustive mutation testing, and not a claim that the suite is complete.
# Thirteen specific things are proved, plus the control. It says nothing about
# whether the 187 tests touched the code they name — core's
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
if [ "$code" -ne 0 ]; then
  record_fail "control: the gate really runs and the proofs appear" \
    "exit $code: $(findings); the gate's own output is in $LOG_DIR/gate.log"
else
  record_pass "control: the gate really runs and all three proofs appear"
  echo "         the gate reported: $(grep -E '^# (tests|suites|pass|fail|skipped) ' "$LOG_DIR/gate.log" | tr '\n' ' ')"
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
edit "$repo/gate.yml" '      minimum: 187' '      minimum: 188'
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
elif grep -q 'FAIL gate.nonzero' "$REPORT"; then
  record_fail "13. one test silently skipped" "the gate did not exit zero, so this was not a silent skip"
else
  record_pass "13. one test silently skipped: caught, and only by the skip proof"
  echo "         the gate's own log said: $(grep -E '^# (tests|suites|pass|skipped) ' "$LOG_DIR/gate.log" | tr '\n' ' ')"
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
