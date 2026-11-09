#!/usr/bin/env bats
# The ccdash uvx shim: runs only basic-memory, creates a missing --project.
bats_require_minimum_version 1.5.0

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  UVX=$ROOT/rootfs/usr/local/bin/uvx
  export HOME=$BATS_TEST_TMPDIR/home
  mkdir -p "$HOME"
  export FAKE_BM_LOG=$BATS_TEST_TMPDIR/bm.log CCDASH_BM=$BATS_TEST_TMPDIR/fake-bm
  unset BASIC_MEMORY_HOME BASIC_MEMORY_CONFIG_DIR CCDASH_BM_PROJECTS_DIR
  cat >"$CCDASH_BM" <<'EOS'
#!/bin/bash
echo "$*" >>"$FAKE_BM_LOG"
[ "$1 $2" = "project list" ] && echo "${FAKE_BM_LIST:-{\"projects\":[]\}}"
[ "$1" = mcp ] && echo "env $BASIC_MEMORY_HOME $BASIC_MEMORY_CONFIG_DIR"
exit 0
EOS
  chmod +x "$CCDASH_BM"
}

@test "execs basic-memory with the same args and default env" {
  run "$UVX" basic-memory mcp
  [ "$status" -eq 0 ]
  [ "$output" = "env $HOME/basic-memory $HOME/.basic-memory" ]
  [ "$(tail -1 "$FAKE_BM_LOG")" = "mcp" ]
}

@test "creates a missing project at the default path, never as default" {
  run "$UVX" basic-memory mcp --project demo
  [ "$status" -eq 0 ]
  grep -qx "project add demo /home/ccd/basic-memory-projects/demo" "$FAKE_BM_LOG"
  run grep -q default "$FAKE_BM_LOG"
  [ "$status" -ne 0 ]
  [ "$(tail -1 "$FAKE_BM_LOG")" = "mcp --project demo" ]
}

@test "--project=name and CCDASH_BM_PROJECTS_DIR" {
  CCDASH_BM_PROJECTS_DIR=/x run "$UVX" basic-memory mcp --project=demo
  [ "$status" -eq 0 ]
  grep -qx "project add demo /x/demo" "$FAKE_BM_LOG"
}

@test "no creation when the project exists" {
  FAKE_BM_LIST='{"projects":[{"name":"demo"}]}' run "$UVX" basic-memory mcp --project demo
  [ "$status" -eq 0 ]
  run grep -q 'project add' "$FAKE_BM_LOG"
  [ "$status" -ne 0 ]
}

@test "invalid project name is not created, bm still runs" {
  run "$UVX" basic-memory mcp --project '../evil'
  [ "$status" -eq 0 ]
  run grep -q '^project' "$FAKE_BM_LOG"
  [ "$status" -ne 0 ]
  [ "$(tail -1 "$FAKE_BM_LOG")" = "mcp --project ../evil" ]
}

@test "other tools are refused with 127" {
  run -127 "$UVX" ruff check
  [ "$status" -eq 127 ]
  [[ $output == *"ccdash uvx shim"* ]]
  run -127 "$UVX"
  [ "$status" -eq 127 ]
  [ ! -e "$FAKE_BM_LOG" ]
}

@test "--from and == forms" {
  run "$UVX" --from basic-memory basic-memory mcp
  [ "$status" -eq 0 ]
  run "$UVX" basic-memory==1.0.0 mcp
  [ "$status" -eq 0 ]
  run "$UVX" --from basic-memory==1.0.0 basic-memory mcp
  [ "$status" -eq 0 ]
  [ "$(grep -cx mcp "$FAKE_BM_LOG")" -eq 3 ]
  run -127 "$UVX" --from other basic-memory mcp
  [ "$status" -eq 127 ]
}

@test "invalid names (.., ., -x, empty) are not added but bm still runs" {
  for name in .. . -x; do
    : >"$FAKE_BM_LOG"
    run "$UVX" basic-memory mcp --project "$name"
    [ "$status" -eq 0 ]
    [ "$(grep -c '^project ' "$FAKE_BM_LOG")" -eq 0 ]
    [ "$(tail -1 "$FAKE_BM_LOG")" = "mcp --project $name" ]
  done
}

@test "--project as the last arg (empty name) is not added but bm still runs" {
  run "$UVX" basic-memory mcp --project
  [ "$status" -eq 0 ]
  [ "$(grep -c '^project ' "$FAKE_BM_LOG")" -eq 0 ]
  [ "$(tail -1 "$FAKE_BM_LOG")" = "mcp --project" ]
}

@test "preset BASIC_MEMORY_HOME and BASIC_MEMORY_CONFIG_DIR are kept" {
  BASIC_MEMORY_HOME=/preset/home BASIC_MEMORY_CONFIG_DIR=/preset/cfg run "$UVX" basic-memory mcp
  [ "$status" -eq 0 ]
  [ "$output" = "env /preset/home /preset/cfg" ]
}
