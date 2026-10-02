#!/usr/bin/env bash
#
# capability_self_test.sh — the proof that `test/customer-capability.test.mjs`
# is measuring something.
#
#   bash test/capability_self_test.sh
#   mise run capability-self-test
#
# WHY THIS IS HERE, IN THE WORDS OF THE FILE IT IMitates
#
# `test/customer-capability.test.mjs` fails on this tree, on purpose, and a file
# that is red for a reason nobody has watched is indistinguishable from a file
# that is red because it is broken. So this script copies this repository to a
# throwaway directory once per case, changes exactly one thing in the copy, and
# asserts that the check answers the question it names. Naming the answer is the
# part that matters: "something went red" could be any assertion at all, including
# an incidental one, and a self-test that accepts any red has stopped testing the
# thing it names.
#
# This is `test/gate_self_test.sh`'s shape, deliberately, and the reason is
# stated in its own header: thirteen reds against a repository that was already
# red prove nothing, so the control comes first. Here the control is a copy with
# NOTHING changed, and it has to produce the two named failures with the two
# named verdicts — not merely a nonzero exit.
#
# IT IS NOT PART OF `mise run prime`, AND THE REASON IS THE SAME ONE
#
# `bin/prime` runs `npm test`, which globs `test/**/*.test.mjs`. A self-test in
# that glob would mean the gate runs the check, the check runs the gate, and a
# gate that verifies itself by running itself terminates — and the termination is
# all it would have proved. So it is a shell script whose name the glob cannot
# match. Two of its four cases run the generator, so it takes a minute.
#
# THE FOUR CASES
#
#   0. CONTROL — an unmodified copy. The tenancy check fails and names ten
#      operations as `absent-from-document`; the OIDC check fails and names five
#      as `no-vendored-document`; the other six tests in the file PASS. A control
#      that only checked the exit code would accept a file whose only problem was
#      that it does not run.
#
#   1. THE FIX THAT IS ALLOWED. Add the ten tenancy operations to a copy of
#      `specs/identity.yaml` — with operationIds, which is what a generator names
#      a method after — bump `expectOperations`, regenerate, and the tenancy check
#      goes GREEN. This is the case that makes the red mean something: the check
#      is capable of the answer `present`, and the only thing that moved between
#      green and red is a document. It is also the demonstration that the fix is a
#      document edit upstream, which is the whole claim of the report.
#
#   2. THE FIX THAT IS FORBIDDEN. Write `createAccount` by hand into a copy of
#      `src/services/identity/sdk.gen.ts`, rebuild, and the tenancy check is STILL
#      RED — now saying "it IS in the generated client, as `createAccount`" beside
#      a verdict of `absent-from-document`. A hand-written sibling is not a fix
#      and this case is what stops it being one: the check reads the document, so
#      a method with no document behind it cannot satisfy it.
#
#   3. GRANULARITY. Take case 1's fixed copy and remove ONE of the ten operations
#      from it — `POST /v1/invitations/accept`, the one that is not under
#      `/v1/accounts` and so is the easiest to overlook. The check goes red again
#      and names that one operation alone. A check that reported "the tenancy
#      surface is missing" without this case could not tell a partial gap from a
#      total one, and a partial gap is what a document grows into.
#
# WHAT IT IS NOT
#
# Not exhaustive, and not a claim that the twenty-three required operations are
# the right twenty-three. That is a judgement, it is written down with a reason
# per entry in `scripts/lib/capability.mjs`, and the first test in the file fails
# if an entry stops carrying its reason. This script proves the check can tell the
# difference between a document that has an operation and a document that does
# not. That is all it claims and all it needs to claim.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cafaye-ts-capability-self-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

if ! command -v node >/dev/null 2>&1; then
  echo "capability_self_test: node is not on PATH. Run 'mise install' first." >&2
  exit 2
fi
if [ ! -d "$ROOT/node_modules" ]; then
  echo "capability_self_test: $ROOT/node_modules does not exist. Run 'npm ci' first; cases" >&2
  echo "  1 and 2 run the generator and the build, and neither works without it." >&2
  exit 2
fi

passed=0
failed=0
failures=""

# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

# copy <name> — a fresh copy of this repository, safe to break.
#
# `node_modules` is a SYMLINK rather than a copy, for a reason that is about
# honesty rather than speed: the generator, the compiler and the test runner must
# be the versions package-lock.json pins, and a copy of the tree that resolved a
# different `typescript` would be testing a different pipeline. `dist` is EXCLUDED
# and not copied, and that is the load-bearing part — `ensureBuilt()` skips the
# build when `dist/index.js` is already there, so a copied `dist` would be a
# client built from the UNBROKEN source and every case below would be reading the
# original tree. Deleting it is what makes each case build from its own breakage.
#
# `.git` is excluded for the same reason `test/gate_self_test.sh` excludes it: a
# copy that kept this worktree's `.git` pointer would read the ORIGINAL index
# through the back door, and a breakage would appear not to have happened. No
# `git init` either, because nothing this script runs reads git state — it runs
# one test file, the generator and `tsc`, and none of the three does. A `git init`
# would be a copy of a habit rather than a requirement.
copy() {
  local name="$1"
  local dst="$WORK/$name"
  if [ -z "$dst" ] || [ "$dst" = "/" ] || [ ! -d "$WORK" ]; then
    echo "  FATAL: refusing to build a copy at '$dst'." >&2
    exit 2
  fi
  rm -rf "$dst"
  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude '.git' --exclude 'node_modules' --exclude 'dist' "$ROOT/" "$dst/"
  else
    (cd "$ROOT" && tar -cf - --exclude '.git' --exclude 'node_modules' --exclude './dist' .) \
      | (cd "$dst" && tar -xf -)
  fi
  ln -s "$ROOT/node_modules" "$dst/node_modules"
  printf '%s' "$dst"
}

# run_check <repo> — run the capability check over one copy and print its output.
#
# The output goes to a file rather than to this script's stdout because the cases
# below grep it, and grepping a live stream is how a case ends up asserting on a
# line the reporter formatted rather than on the finding.
run_check() {
  local repo="$1"
  if [ -z "$repo" ] || [ ! -d "$repo" ]; then
    echo "  FATAL: run_check was handed '$repo', which is not a copy." >&2
    exit 2
  fi
  OUT="$WORK/$(basename "$repo").out"
  (cd "$repo" && node --test test/customer-capability.test.mjs) > "$OUT" 2>&1
  return $?
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

# expect <name> <condition-description> <0-or-1> <detail>
expect() {
  local name="$1" what="$2" ok="$3" detail="${4:-}"
  if [ "$ok" = "0" ]; then
    record_pass "$name"
  else
    record_fail "$name" "${what}${detail:+ — $detail}"
  fi
}

# wants <text> — is <text> somewhere in the last run's output?
wants() {
  grep -qF -- "$1" "$OUT"
}

# test_passed <name> / test_failed <name> — did one NAMED test in the file pass or
# fail?
#
# Per-test rather than per-file, and the reason is the shape of the file itself.
# `test/customer-capability.test.mjs` carries TWO independent findings, so "the
# file exited 0" is true only when both are closed, and a case that fixes one of
# them would read as a failure of the check rather than of the case. Naming the
# test says which finding moved.
test_passed() {
  grep -qE "^ +ok [0-9]+ - $1\$" "$OUT"
}

test_failed() {
  grep -qE "^ +not ok [0-9]+ - $1\$" "$OUT"
}

TENANCY_TEST='a customer can create an account, invite a member, accept the invitation, and obtain a session'
OIDC_TEST="a customer can put this platform's sign-in on their own product"

# The ten tenancy operations, as a YAML block, and the one that is not under
# /v1/accounts.
#
# A FILE rather than a shell variable, and that is not tidiness. The obvious
# spelling is `read -r -d '' VAR <<'YAML'`, and it is wrong: `read` strips
# leading IFS whitespace from the value it assigns, so the FIRST line of the
# block loses its two spaces of indentation, `/v1/accounts:` lands at column 0,
# and the generator refuses the document with a parse error 24 lines further on
# — a failure that reads as a malformed recipe and is actually a stripped indent.
# It cost one run of this script to find. `cat > file <<'YAML'` moves the bytes.
write_tenancy_fixture() {
  cat > "$1" <<'YAML'
  /v1/accounts:
    post:
      tags: [accounts]
      operationId: createAccount
      summary: Create an account
      responses:
        '201':
          description: The account was created
          content:
            application/json:
              schema:
                type: object
    get:
      tags: [accounts]
      operationId: listAccounts
      summary: List the caller's accounts
      responses:
        '200':
          description: The accounts
          content:
            application/json:
              schema:
                type: object
  /v1/accounts/{account_id}:
    parameters:
      - name: account_id
        in: path
        required: true
        schema:
          type: string
    get:
      tags: [accounts]
      operationId: getAccount
      summary: Read one account
      responses:
        '200':
          description: The account
          content:
            application/json:
              schema:
                type: object
    patch:
      tags: [accounts]
      operationId: updateAccount
      summary: Rename an account
      responses:
        '200':
          description: The renamed account
          content:
            application/json:
              schema:
                type: object
    delete:
      tags: [accounts]
      operationId: deleteAccount
      summary: Delete an account
      responses:
        '204':
          description: Gone
  /v1/accounts/{account_id}/members:
    parameters:
      - name: account_id
        in: path
        required: true
        schema:
          type: string
    get:
      tags: [accounts]
      operationId: listAccountMembers
      summary: List an account's members
      responses:
        '200':
          description: The members
          content:
            application/json:
              schema:
                type: object
  /v1/accounts/{account_id}/invitations:
    parameters:
      - name: account_id
        in: path
        required: true
        schema:
          type: string
    post:
      tags: [accounts]
      operationId: createAccountInvitation
      summary: Invite somebody into an account
      responses:
        '201':
          description: The invitation
          content:
            application/json:
              schema:
                type: object
  /v1/accounts/{account_id}/members/{user_id}:
    parameters:
      - name: account_id
        in: path
        required: true
        schema:
          type: string
      - name: user_id
        in: path
        required: true
        schema:
          type: string
    patch:
      tags: [accounts]
      operationId: updateAccountMember
      summary: Change a member's role
      responses:
        '200':
          description: The member
          content:
            application/json:
              schema:
                type: object
    delete:
      tags: [accounts]
      operationId: deleteAccountMember
      summary: Remove a member
      responses:
        '204':
          description: Gone
  /v1/invitations/accept:
    post:
      tags: [accounts]
      operationId: acceptInvitation
      summary: Accept an invitation
      responses:
        '200':
          description: The membership
          content:
            application/json:
              schema:
                type: object
YAML
}

# inject_paths <spec> — add the ten tenancy operations to a document, and move
# `expectOperations` with them.
#
# The insertion point is the line before the first COLUMN-ZERO key after
# `paths:`, which is how a YAML mapping's next sibling is found. Appending to the
# end of the file would have put ten path items inside `components:`, which parses
# and generates nothing — the kind of mutation that makes a self-test report a red
# for a reason that has nothing to do with the case it names.
#
# `expectOperations` moves in the same breath, because that is the documented
# procedure for re-vendoring a document whose size changed, and a copy that
# skipped it would be a copy of a procedure nobody would follow.
inject_paths() {
  node - "$1" "$2" <<'NODEEOF'
const { readFileSync, writeFileSync } = require('node:fs');
const [specPath, additionPath] = process.argv.slice(2);
const block = readFileSync(additionPath, 'utf8').replace(/\n$/, '').split('\n');
const lines = readFileSync(specPath, 'utf8').split('\n');

const pathsAt = lines.findIndex((line) => line === 'paths:');
if (pathsAt < 0) {
  process.stderr.write(`inject_paths: no top-level \`paths:\` in ${specPath}\n`);
  process.exit(2);
}
let insertAt = lines.length;
for (let i = pathsAt + 1; i < lines.length; i += 1) {
  if (/^[A-Za-z]/.test(lines[i])) {
    insertAt = i;
    break;
  }
}
if (insertAt === lines.length) {
  process.stderr.write(`inject_paths: \`paths:\` has no following key in ${specPath}\n`);
  process.exit(2);
}
writeFileSync(specPath, [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)].join('\n'));

const indexPath = specPath.replace(/specs\/([^/]+)\.yaml$/, 'specs/index.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
const service = specPath.replace(/.*specs\/([^/]+)\.yaml$/, '$1');
const entry = index.services.find((s) => s.service === service);
if (!entry) {
  process.stderr.write(`inject_paths: ${service} is not in ${indexPath}\n`);
  process.exit(2);
}
// Ten operations, ten path items is not the ratio: /v1/accounts gains two
// methods, /v1/accounts/{account_id} gains three, members one, invitations one,
// members/{user_id} two, and /v1/invitations/accept one. The count is asserted
// rather than computed so a wrong recipe is loud instead of quietly measuring a
// different number than the one the case names.
const added = 10;
for (const field of ['expectOperations', 'operations']) {
  if (typeof entry[field] === 'number') entry[field] += added;
}
writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
process.stdout.write(`  injected ${added} operations into ${service}'s document\n`);
NODEEOF
}

# drop_operation <spec> <operationId> — remove one operation from a document, the
# way a partial fix would leave it.
drop_operation() {
  node - "$1" "$2" <<'NODEEOF'
const { readFileSync, writeFileSync } = require('node:fs');
const [specPath, operationId] = process.argv.slice(2);
const lines = readFileSync(specPath, 'utf8').split('\n');

const at = lines.findIndex((line) => line.trim() === `operationId: ${operationId}`);
if (at < 0) {
  process.stderr.write(`drop_operation: no \`operationId: ${operationId}\` in ${specPath}\n`);
  process.exit(2);
}
// The operation body runs from its own method key to the next key at the same or
// a shallower indentation. Walking up to the method key first, rather than
// starting at the operationId, is what removes the `post:` and not just the
// fields under it — an operation whose `post:` is still declared but whose body
// is gone is a different mutation and would measure something else.
let start = at;
while (start > 0 && !/^ {4}(get|put|post|delete|patch|head|options):$/.test(lines[start])) start -= 1;
if (start === 0) {
  process.stderr.write(`drop_operation: no method key above \`${operationId}\`\n`);
  process.exit(2);
}
let end = start + 1;
while (end < lines.length && (lines[end].trim() === '' || /^ {4,6}\S/.test(lines[end]))) end += 1;
writeFileSync(specPath, [...lines.slice(0, start), ...lines.slice(end)].join('\n'));
process.stdout.write(`  removed ${operationId}\n`);
NODEEOF
}

# hand_write_a_method <repo> — do the forbidden thing, in a copy.
#
# TWO files, not one, and the second one is a finding rather than a detail. The
# generator's `entryFile: true` emits an `index.ts` that re-exports the SDK by
# NAME — one long `export { … } from './sdk.gen.js'` — so a function written into
# `sdk.gen.ts` and nothing else is not reachable through
# `cafaye-ts/services/identity` at all. Somebody attempting this fix has to edit
# two generated files, both of which carry a `DO NOT EDIT` header, and
# `test/regeneration.test.mjs` reverts both on the next generate.
#
# The copy gets both, so that the case measures the strongest version of the
# forbidden fix: a method that a consumer could actually call. Ten functions
# would demonstrate the same thing at ten times the cost, and the case is about
# the VERDICT rather than about the count.
hand_write_a_method() {
  node - "$1" <<'NODEEOF'
const { readFileSync, writeFileSync } = require('node:fs');
const root = process.argv[2];
const sdk = `${root}/src/services/identity/sdk.gen.ts`;
const entry = `${root}/src/services/identity/index.ts`;

const body = readFileSync(sdk, 'utf8');
if (body.includes('export const createAccount')) {
  process.stderr.write('hand_write_a_method: already present\n');
  process.exit(2);
}
writeFileSync(
  sdk,
  `${body}\nexport const createAccount = (options: Record<string, unknown>) =>\n` +
    "    (options.client as { post: (o: unknown) => unknown }).post({\n" +
    "        url: '/v1/accounts',\n" +
    '        ...options\n' +
    '    });\n',
);

const index = readFileSync(entry, 'utf8');
const anchor = 'export { completeSecondFactor,';
if (!index.includes(anchor)) {
  process.stderr.write('hand_write_a_method: the generated entry file has moved\n');
  process.exit(2);
}
writeFileSync(entry, index.replace(anchor, 'export { completeSecondFactor, createAccount,'));
process.stdout.write('  hand-wrote createAccount into sdk.gen.ts and index.ts\n');
NODEEOF
}

echo "capability_self_test — is test/customer-capability.test.mjs measuring anything?"
echo

# --------------------------------------------------------------------------
# case 0 — the control
# --------------------------------------------------------------------------

control="$(copy control)"
run_check "$control"
control_code=$?

passing_tests="$(grep -cE '^ +ok [0-9]+ - ' "$OUT")"
failing_tests="$(grep -cE '^ +not ok [0-9]+ - ' "$OUT")"

expect "0a  an unmodified copy runs the check and it fails" \
  "the check exited $control_code" \
  "$([ "$control_code" -ne 0 ] && echo 0 || echo 1)" \
  "the control must be red; a green control makes every case below meaningless"

expect "0b  ... and the tenancy failure names the ten as absent from the DOCUMENT" \
  "the output does not carry the verdict" \
  "$(wants 'absent-from-document   POST /v1/accounts' && echo 0 || echo 1)"

expect "0c  ... and the OIDC failure names the five as having NO vendored document" \
  "the output does not carry the verdict" \
  "$(wants 'no-vendored-document   GET /.well-known/openid-configuration' && echo 0 || echo 1)"

expect "0d  ... and the other six tests in the file pass" \
  "the control has $failing_tests failures, not 2" \
  "$([ "$failing_tests" -eq 2 ] && [ "$passing_tests" -eq 6 ] && echo 0 || echo 1)" \
  "saw $passing_tests passing, $failing_tests failing"

# --------------------------------------------------------------------------
# case 1 — the fix that is allowed: edit the document
# --------------------------------------------------------------------------

fixed="$(copy fixed)"
write_tenancy_fixture "$WORK/tenancy.yaml"
if ! inject_paths "$fixed/specs/identity.yaml" "$WORK/tenancy.yaml"; then
  echo "  FATAL: inject_paths did not apply. This self-test is stale and every result" >&2
  echo "  below it would be meaningless." >&2
  exit 2
fi
if ! (cd "$fixed" && node scripts/generate.mjs identity) > "$WORK/generate.log" 2>&1; then
  echo "  FATAL: the generator refused the document this case built. Its output:" >&2
  cat "$WORK/generate.log" >&2
  exit 2
fi

run_check "$fixed"

expect "1a  a document that describes the ten, and a client regenerated from it, satisfies the tenancy check" \
  "the tenancy check is still failing over a fixed copy" \
  "$(test_passed "$TENANCY_TEST" && echo 0 || echo 1)" \
  "a red here means the check can never be satisfied, which would make it a constant rather than a measurement"

expect "1b  ... and the tenancy names are gone from the output" \
  "the tenancy operation still appears" \
  "$(wants 'absent-from-document   POST /v1/accounts' && echo 1 || echo 0)"

expect "1c  ... while the OIDC check is STILL red, because no document was added for it" \
  "the OIDC verdict disappeared" \
  "$(test_failed "$OIDC_TEST" && echo 0 || echo 1)" \
  "two findings, two causes; a fix for one must not close the other, and a check that let it " \
  "would be measuring the file rather than the product"

# --------------------------------------------------------------------------
# case 2 — the fix that is forbidden: hand-write the method
# --------------------------------------------------------------------------

handed="$(copy handed)"
if ! hand_write_a_method "$handed"; then
  echo "  FATAL: hand_write_a_method did not apply. This self-test is stale." >&2
  exit 2
fi
# The build is explicit rather than left to the check's own `ensureBuilt()`,
# because this case needs the BUILD to succeed or the copy has measured nothing:
# a `tsc` error would leave `dist/` holding the pre-hand-edit tree, the probe
# would find no `createAccount`, and 2b would pass for the wrong reason. A
# self-test whose assertion can be satisfied by its own setup failing is not
# testing what it names.
if ! (cd "$handed" && npm run build) > "$WORK/handed-build.log" 2>&1; then
  echo "  FATAL: the hand-written method did not compile. Its output:" >&2
  cat "$WORK/handed-build.log" >&2
  exit 2
fi
if ! (cd "$handed" && node -e "
  import('./dist/services/identity/index.js').then((m) => {
    if (typeof m.createAccount !== 'function') {
      process.stderr.write('createAccount is not exported from the built entry file\n');
      process.exit(2);
    }
  });
") 2>&1; then
  echo "  FATAL: the hand-written method did not reach the built entry file, so this case" >&2
  echo "  would measure a copy where the forbidden fix was never visible." >&2
  exit 2
fi

run_check "$handed"

expect "2a  a HAND-WRITTEN method does NOT satisfy the tenancy check" \
  "the tenancy check passed over a copy with a hand-written createAccount" \
  "$(test_failed "$TENANCY_TEST" && echo 0 || echo 1)" \
  "a check a forbidden fix can satisfy is not checking the document"

expect "2b  ... and it says so: the method IS in the client, and the verdict is still absent-from-document" \
  "the output does not name the hand-written method beside its verdict" \
  "$(wants 'as `createAccount`' && wants 'absent-from-document   POST /v1/accounts' && echo 0 || echo 1)" \
  "this is the line that makes the verdict legible: the method exists, the document does not"

# --------------------------------------------------------------------------
# case 3 — granularity: one operation missing out of ten
# --------------------------------------------------------------------------

partial="$(copy partial)"
cp "$fixed/specs/identity.yaml" "$partial/specs/identity.yaml"
cp "$fixed/specs/index.json" "$partial/specs/index.json"
cp -R "$fixed/src/services/identity/." "$partial/src/services/identity/"
if ! drop_operation "$partial/specs/identity.yaml" acceptInvitation; then
  echo "  FATAL: drop_operation did not apply. This self-test is stale." >&2
  exit 2
fi

run_check "$partial"

expect "3a  nine of the ten documented and one missing is RED again" \
  "the tenancy check was green over a partially fixed copy" \
  "$(test_failed "$TENANCY_TEST" && echo 0 || echo 1)"

expect "3b  ... and it names that ONE operation, and no other" \
  "the named set is not exactly the one operation" \
  "$(
    named="$(grep -oE 'absent-from-document   [A-Z]+ [^ ]+' "$OUT" | sort -u | wc -l | tr -d ' ')"
    if [ "$named" -eq 1 ] && wants 'absent-from-document   POST /v1/invitations/accept'; then
      echo 0
    else
      echo 1
    fi
  )" \
  "a check that could only say 'the tenancy surface is missing' could not tell this from case 0"

# --------------------------------------------------------------------------

echo
echo "$((passed)) passed, $failed failed"
if [ "$failed" -ne 0 ]; then
  printf 'failures:%s\n' "$failures"
  exit 1
fi
exit 0
