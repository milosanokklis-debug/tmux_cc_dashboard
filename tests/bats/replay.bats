#!/usr/bin/env bats

setup() { ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd); }

@test "replay passes on the committed fixtures" {
  run "$ROOT/tests/replay-fixtures.sh"
  [ "$status" -eq 0 ]
  [[ $output == *"PASS SessionStart"* ]]
}

@test "replay fails on a fixture with a wrong hook_event_name" {
  cp -r "$ROOT/tests/fixtures/2.1.317" "$BATS_TEST_TMPDIR/fx"
  jq '.hook_event_name="Nope"' "$ROOT/tests/fixtures/2.1.317/PostToolUse.json" >"$BATS_TEST_TMPDIR/fx/PostToolUse.json"
  FIXTURES_DIR=$BATS_TEST_TMPDIR/fx run "$ROOT/tests/replay-fixtures.sh"
  [ "$status" -ne 0 ]
  [[ $output == *"FAIL PostToolUse"* ]]
}

@test "replay fails on a synthetic fixture missing the flag" {
  cp -r "$ROOT/tests/fixtures/2.1.317" "$BATS_TEST_TMPDIR/fx"
  jq 'del(.synthetic)' "$ROOT/tests/fixtures/2.1.317/StopFailure.json" >"$BATS_TEST_TMPDIR/fx/StopFailure.json"
  FIXTURES_DIR=$BATS_TEST_TMPDIR/fx run "$ROOT/tests/replay-fixtures.sh"
  [ "$status" -ne 0 ]
}

@test "replay fails when a configured hook crashes" {
  cp -r "$ROOT/tests/fixtures/2.1.317" "$BATS_TEST_TMPDIR/fx"
  echo '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"exit 3"}]}]}}' >"$BATS_TEST_TMPDIR/s.json"
  SETTINGS=$BATS_TEST_TMPDIR/s.json FIXTURES_DIR=$BATS_TEST_TMPDIR/fx run "$ROOT/tests/replay-fixtures.sh"
  [ "$status" -ne 0 ]
  [[ $output == *"FAIL Stop"* ]]
}
