#!/usr/bin/env bats
# hooks/statusline.sh: the usage record, the printed line, and "never fails Claude".

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  SL=$ROOT/rootfs/usr/local/lib/ccdash/hooks/statusline.sh
  FIX=$ROOT/tests/fixtures/2.1.317/statusline.json
  export HOME=$BATS_TEST_TMPDIR/home
  mkdir -p "$HOME"
  unset CCDASH_HIDDEN CCDASH_STATUSLINE_CMD
  U=$HOME/.ccdash/usage
  SID=0145a79c-4d3f-49ed-a2fc-f420147be356
}

@test "managed settings point statusLine at the script" {
  [ "$(jq -r '.statusLine | "\(.type) \(.command)"' "$ROOT/rootfs/etc/claude-code/managed-settings.json")" = "command /usr/local/lib/ccdash/hooks/statusline.sh" ]
}

@test "records ts, rate_limits, cost, context_window and model; 0640; no temp file left" {
  run "$SL" <"$FIX"
  [ "$status" -eq 0 ]
  [ "$output" = "Opus 5.5 · ctx 8%" ]
  f=$U/$SID.json
  [ "$(jq -r '.rate_limits.five_hour.used_percentage' "$f")" = 23.5 ]
  [ "$(jq -r '.rate_limits.seven_day.resets_at' "$f")" = 1790400000 ]
  [ "$(jq -r '.cost.total_cost_usd' "$f")" = 0.0123 ]
  [ "$(jq -r '.context_window.context_window_size' "$f")" = 200000 ]
  [ "$(jq -r '.model.id' "$f")" = claude-opus-5-5 ]
  [ "$(jq -r '.ts | type' "$f")" = number ]
  [ "$(stat -c %a "$f")" = 640 ]
  [ "$(ls -A "$U")" = "$SID.json" ]
}

@test "a payload without rate_limits records null, not a guess" {
  jq 'del(.rate_limits)' "$FIX" | "$SL" >/dev/null
  [ "$(jq -c '.rate_limits' "$U/$SID.json")" = null ]
}

@test "a missing used_percentage prints ?" {
  run "$SL" < <(jq 'del(.context_window.used_percentage)' "$FIX")
  [ "$output" = "Opus 5.5 · ctx ?%" ]
}

@test "CCDASH_STATUSLINE_CMD replaces the printed line and gets the payload on stdin" {
  CCDASH_STATUSLINE_CMD='jq -r .cwd' run "$SL" <"$FIX"
  [ "$status" -eq 0 ]
  [ "$output" = /workspace/_h2probe ]
  [ -f "$U/$SID.json" ]
}

@test "CCDASH_HIDDEN=1 records nothing but still prints" {
  CCDASH_HIDDEN=1 run "$SL" <"$FIX"
  [ "$status" -eq 0 ]
  [ "$output" = "Opus 5.5 · ctx 8%" ]
  [ ! -e "$U" ]
}

@test "a bad session id or invalid JSON writes nothing and exits 0" {
  jq '.session_id = "../../x"' "$FIX" | "$SL" >/dev/null
  run "$SL" <<<'{not json'
  [ "$status" -eq 0 ]
  [ -z "$(ls -A "$U" 2>/dev/null)" ]
}

@test "with jq removed it still exits 0 and prints a line" {
  mkdir -p "$BATS_TEST_TMPDIR/nojq"
  for c in bash cat mkdir date mktemp rm chmod mv; do ln -s "$(command -v $c)" "$BATS_TEST_TMPDIR/nojq/$c"; done
  PATH=$BATS_TEST_TMPDIR/nojq run "$SL" <"$FIX"
  [ "$status" -eq 0 ]
  [ "$output" = "? · ctx ?%" ]
}
