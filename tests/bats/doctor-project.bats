#!/usr/bin/env bats
# ccd-doctor with per-project Claude config dirs: the claude it starts runs under a signed-in project's config dir,
# a fresh install (no signed-in project) skips the claude checks, and the cleanup matches state records by name.

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  TD=$(mktemp -d /tmp/ccdt.XXXXXX)
  export HOME=$TD/home
  export CCDASH_WS=$TD/ws
  export CCDASH_TMUX=$TD/t.sock
  export CCDASH_PROJECT_LIB=$ROOT/rootfs/usr/local/lib/ccdash
  export CCDASH_CONFIG_ROOT=$TD/cfg
  export FAKE_CLAUDE_HOME=$TD/fake
  export FAKE_CLAUDE_FIXTURES=$ROOT/tests/fixtures/2.1.317
  export CCDASH_FIXTURES=$ROOT/tests/fixtures/2.1.317
  export CCDASH_DOCTOR_WAIT=5 CCDASH_DOCTOR_ESC_WAIT=5 CCDASH_DOCTOR_HOOK_TIMEOUT=2 CCDASH_DOCTOR_SETTLE=1
  mkdir -p "$HOME/bin" "$HOME/.ccdash/sessions" "$CCDASH_WS/demo" "$CCDASH_CONFIG_ROOT/alpha" "$CCDASH_CONFIG_ROOT/beta" "$FAKE_CLAUDE_HOME"
  # records the config dir every REPL start sees, then runs the fake
  printf '#!/bin/bash\n[ "${1:-}" = auth ] || [ "${1:-}" = mcp ] || echo "${CLAUDE_CONFIG_DIR:-unset}" >>%s/cfg.log\nexec %s/tests/fake-claude/claude "$@"\n' "$TD" "$ROOT" >"$HOME/bin/claude"
  chmod +x "$HOME/bin/claude"
  printf 'export PATH=%s/bin:$PATH\n' "$HOME" >"$HOME/.bash_profile"
  export PATH=$HOME/bin:$ROOT/rootfs/usr/local/bin:$PATH
  unset TMUX TMUX_PANE CCDASH_CLAUDE_HOME
}

teardown() { tmux -S "$CCDASH_TMUX" kill-server 2>/dev/null || true; rm -rf "$TD"; }

signin() { mkdir -p "$FAKE_CLAUDE_HOME/accounts/$1"; : >"$FAKE_CLAUDE_HOME/accounts/$1/logged-in"; }

@test "--live runs claude under the config dir of the first signed-in project" {
  signin beta
  run ccd-doctor
  [ "$status" -eq 0 ]
  [ -s "$TD/cfg.log" ]
  [ "$(sort -u "$TD/cfg.log")" = "$CCDASH_CONFIG_ROOT/beta" ]
  [[ $output == *'"check":"hook_payloads","status":"pass"'* ]]
}

@test "no signed-in project: the claude checks are skipped, claude is not started, exit 0" {
  run ccd-doctor
  [ "$status" -eq 0 ]
  [[ $output == *"skip: no signed-in project"* ]]
  [ ! -e "$TD/cfg.log" ]
  [[ $output != *'"status":"warn"'* ]]
}

@test "cleanup removes the scratch records by project name and by the old path, and keeps others" {
  d=$HOME/.ccdash/sessions
  echo '{"project":"_selftest"}' >"$d/a.json"
  echo "{\"project\":\"$CCDASH_WS/_selftest\"}" >"$d/b.json"
  echo '{"project":"demo"}' >"$d/c.json"
  run ccd-doctor
  [ "$status" -eq 0 ]
  [ ! -e "$d/a.json" ]
  [ ! -e "$d/b.json" ]
  [ -e "$d/c.json" ]
}
