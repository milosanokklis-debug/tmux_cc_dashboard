#!/usr/bin/env bats
# Claude accounts: name rules, account dirs, per-account basic-memory registration, ccd login/accounts.
# Uses the fake claude (state per CLAUDE_CONFIG_DIR) and a docker stub that runs the command locally.

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  LIB=$ROOT/rootfs/usr/local/lib/ccdash
  BIN=$ROOT/rootfs/usr/local/bin
  export HOME=$BATS_TEST_TMPDIR/home
  export FAKE_CLAUDE_HOME=$BATS_TEST_TMPDIR/fake
  export CCDASH_ACCOUNTS_DIR=$BATS_TEST_TMPDIR/accounts CCDASH_ACCOUNTS_LIB=$LIB
  export CCDASH_MEMORY_HOME=$HOME FAKE_CLAUDE_MCP=none
  export FAKE_BM_LOG=$BATS_TEST_TMPDIR/bm.log CCDASH_BM=$BATS_TEST_TMPDIR/fake-bm
  export CCDASH_DOCKER=$BATS_TEST_TMPDIR/docker
  mkdir -p "$HOME/bin"
  ln -s "$ROOT/tests/fake-claude/claude" "$HOME/bin/claude"
  export PATH=$HOME/bin:$BIN:$PATH
  unset CLAUDE_CONFIG_DIR
  printf '#!/bin/bash\necho "$*" >>"$FAKE_BM_LOG"\n[ "$1 $2" = "project list" ] && echo "{\\"projects\\":[{\\"name\\":\\"main\\",\\"is_default\\":true}]}"\nexit 0\n' >"$CCDASH_BM"
  chmod +x "$CCDASH_BM"
  cat >"$CCDASH_DOCKER" <<'STUB'
#!/bin/bash
[ "$1" = exec ] || exit 1
shift; while [ "$1" = -i ] || [ "$1" = -it ] || [ "$1" = -u ]; do [ "$1" = -u ] && shift; shift; done; shift; exec "$@"
STUB
  chmod +x "$CCDASH_DOCKER"
}

@test "name validation" {
  . "$LIB/accounts.sh"
  account_valid default
  account_valid work
  account_valid a1_b-c
  account_valid "$(printf 'a%.0s' {1..32})"
  for bad in Work -x _x .. a.b a/b "" "$(printf 'a%.0s' {1..33})"; do
    ! account_valid "$bad" || { echo "accepted: $bad"; false; }
  done
}

@test "default resolves to no config dir, others to the accounts dir, bad names fail" {
  . "$LIB/accounts.sh"
  [ -z "$(account_config_dir default)" ]
  [ "$(account_config_dir work)" = "$CCDASH_ACCOUNTS_DIR/work" ]
  run account_config_dir ..
  [ "$status" -ne 0 ]
}

@test "account_create makes a 0700 dir, is idempotent, refuses default and bad names" {
  . "$LIB/accounts.sh"
  account_create work
  [ "$(stat -c %a "$CCDASH_ACCOUNTS_DIR/work")" = 700 ]
  [ "$(stat -c %a "$CCDASH_ACCOUNTS_DIR")" = 700 ]
  account_create work
  run account_create default
  [ "$status" -ne 0 ]
  run account_create ../x
  [ "$status" -ne 0 ]
  [ ! -e "$CCDASH_ACCOUNTS_DIR/default" ]
}

@test "account_list: default first, then sorted" {
  . "$LIB/accounts.sh"
  account_create zed; account_create alpha
  [ "$(account_list | tr '\n' ' ')" = "default alpha zed " ]
}

@test "ccd-memory-init registers in the default and every account, once each" {
  . "$LIB/accounts.sh"
  account_create work
  run "$BIN/ccd-memory-init"
  [ "$status" -eq 0 ]
  [ "$(wc -l <"$FAKE_CLAUDE_HOME/mcp-add.log")" -eq 1 ]
  [ "$(wc -l <"$FAKE_CLAUDE_HOME/accounts/work/mcp-add.log")" -eq 1 ]
  grep -q -- "BASIC_MEMORY_HOME=$HOME/basic-memory" "$FAKE_CLAUDE_HOME/accounts/work/mcp-add.log"
  run "$BIN/ccd-memory-init"
  [ "$(wc -l <"$FAKE_CLAUDE_HOME/mcp-add.log")" -eq 1 ]
  [ "$(wc -l <"$FAKE_CLAUDE_HOME/accounts/work/mcp-add.log")" -eq 1 ]
}

@test "ccd-account create registers basic-memory for the new account only" {
  . "$LIB/accounts.sh"
  account_create work
  run "$BIN/ccd-account" create alt
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ -f "$FAKE_CLAUDE_HOME/accounts/alt/mcp-add.log" ]
  [ ! -e "$FAKE_CLAUDE_HOME/accounts/work/mcp-add.log" ]
  [ ! -e "$FAKE_CLAUDE_HOME/mcp-add.log" ]
}

@test "ccd-memory-init continues past a failing account, still sets up main, reports it" {
  . "$LIB/accounts.sh"
  account_create bad; account_create work
  printf '#!/bin/bash\n[ "${CLAUDE_CONFIG_DIR:-}" = "%s/bad" ] && exit 1\nexec %s "$@"\n' "$CCDASH_ACCOUNTS_DIR" "$ROOT/tests/fake-claude/claude" >"$HOME/bin/claude.new"
  chmod +x "$HOME/bin/claude.new"; rm "$HOME/bin/claude"; mv "$HOME/bin/claude.new" "$HOME/bin/claude"
  run "$BIN/ccd-memory-init"
  [ "$status" -eq 0 ]
  [[ $output == *"(bad)"* ]]
  [ -f "$FAKE_CLAUDE_HOME/mcp-add.log" ]
  [ -f "$FAKE_CLAUDE_HOME/accounts/work/mcp-add.log" ]
  grep -q '^project list' "$FAKE_BM_LOG"
}

@test "ccd login on an existing account registers memory again" {
  . "$LIB/accounts.sh"
  account_create work
  [ ! -e "$FAKE_CLAUDE_HOME/accounts/work/mcp-add.log" ]
  run "$ROOT/bin/ccd" login --account work </dev/null
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ -f "$FAKE_CLAUDE_HOME/accounts/work/mcp-add.log" ]
}

@test "symlinked entries are not listed and cannot be created over" {
  . "$LIB/accounts.sh"
  account_create real
  ln -s "$CCDASH_ACCOUNTS_DIR/real" "$CCDASH_ACCOUNTS_DIR/link"
  [ "$(account_list | tr '\n' ' ')" = "default real " ]
  run account_create link
  [ "$status" -ne 0 ]
}

@test "ccd login --account creates the dir, registers basic-memory" {
  run "$ROOT/bin/ccd" login --account work </dev/null
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ "$(stat -c %a "$CCDASH_ACCOUNTS_DIR/work")" = 700 ]
  [ -f "$FAKE_CLAUDE_HOME/accounts/work/mcp-add.log" ]
  [ -f "$FAKE_CLAUDE_HOME/mcp-add.log" ] # login runs the idempotent full registration
}

@test "ccd login without --account runs claude with CLAUDE_CONFIG_DIR unset and creates nothing" {
  printf '#!/bin/bash\necho "cfg=${CLAUDE_CONFIG_DIR-unset}" >"$FAKE_BM_LOG.env"\n' >"$HOME/bin/claude.sh"
  chmod +x "$HOME/bin/claude.sh"
  rm "$HOME/bin/claude"; ln -s "$HOME/bin/claude.sh" "$HOME/bin/claude"
  CLAUDE_CONFIG_DIR=/leak run "$ROOT/bin/ccd" login </dev/null
  [ "$status" -eq 0 ]
  [ "$(cat "$FAKE_BM_LOG.env")" = "cfg=unset" ]
  [ ! -e "$CCDASH_ACCOUNTS_DIR" ]
}

@test "ccd login rejects bad account names and default as a created name" {
  run "$ROOT/bin/ccd" login --account Bad </dev/null
  [ "$status" -ne 0 ]
  [ ! -e "$CCDASH_ACCOUNTS_DIR/Bad" ]
  run "$ROOT/bin/ccd" login --account </dev/null
  [ "$status" -eq 2 ]
}

@test "ccd accounts lists names with per-dir logged-in state" {
  . "$LIB/accounts.sh"
  account_create work; account_create other
  mkdir -p "$FAKE_CLAUDE_HOME/accounts/work"; : >"$FAKE_CLAUDE_HOME/accounts/work/logged-in"
  run "$ROOT/bin/ccd" accounts
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = $'default\tnot logged in' ]
  [ "${lines[1]}" = $'other\tnot logged in' ]
  [ "${lines[2]}" = $'work\tlogged in' ]
  mkdir -p "$FAKE_CLAUDE_HOME"; : >"$FAKE_CLAUDE_HOME/logged-in"
  run "$ROOT/bin/ccd" accounts
  [ "${lines[0]}" = $'default\tlogged in' ]
  [ "${lines[1]}" = $'other\tnot logged in' ]
}

@test "ccd-account create: makes the account dir and registers basic-memory, no claude started; refuses default and bad names" {
  run ccd-account create work
  [ "$status" -eq 0 ]
  [ "$output" = work ] || [[ $output == *work ]]
  [ -d "$CCDASH_ACCOUNTS_DIR/work" ]
  [ "$(stat -c %a "$CCDASH_ACCOUNTS_DIR/work")" = 700 ]
  run ccd-account create work
  [ "$status" -eq 0 ]
  for bad in default Work ../x ""; do
    run ccd-account create "$bad"
    [ "$status" -eq 2 ] || { echo "accepted: $bad"; false; }
  done
  run ccd-account create
  [ "$status" -eq 2 ]
}
