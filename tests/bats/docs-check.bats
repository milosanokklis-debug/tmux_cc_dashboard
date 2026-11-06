#!/usr/bin/env bats

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  export DOCS_README=$BATS_TEST_TMPDIR/README.md
}

readme() { printf '%s\n' "$@" >"$DOCS_README"; }

@test "passes on valid ccd commands and flags" {
  readme '# x' '```bash' 'ccd ls' '$ ccd clone --trust-hooks owner/repo' 'ccd passwd --totp' '```'
  run "$ROOT/tests/docs-check.sh"
  [ "$status" -eq 0 ]
  [[ $output == *"3 command(s)"* ]]
}

@test "fails on an unknown subcommand" {
  readme '```' 'ccd frobnicate' '```'
  run "$ROOT/tests/docs-check.sh"
  [ "$status" -ne 0 ]
  [[ $output == *"frobnicate"* ]]
}

@test "fails on an unknown flag" {
  readme '```' 'ccd clone --nope owner/repo' '```'
  run "$ROOT/tests/docs-check.sh"
  [ "$status" -ne 0 ]
  [[ $output == *"--nope"* ]]
}

@test "ignores commands outside code fences" {
  readme 'ccd frobnicate' '```' 'ccd ls' '```'
  run "$ROOT/tests/docs-check.sh"
  [ "$status" -eq 0 ]
}

@test "fails when no command is checked" {
  readme '# nothing here' '```' 'echo hi' '```'
  run "$ROOT/tests/docs-check.sh"
  [ "$status" -ne 0 ]
  [[ $output == *"no checked commands"* ]]
}

@test "setup.sh lines are skipped with a note while setup.sh is absent" {
  [ ! -f "$ROOT/setup.sh" ] || skip "setup.sh exists"
  readme '```' 'ccd ls' 'sudo ./setup.sh --whatever' '```'
  run "$ROOT/tests/docs-check.sh"
  [ "$status" -eq 0 ]
  [[ $output == *"skipping"* ]]
}
