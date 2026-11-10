#!/usr/bin/env bats
# One Claude login per project (step 1 of docs/handoff/project-sessions.md): config dir per project,
# `ccd-session login|auth|start`, hook records keyed by project, shared accounts gone.
# CCDASH_CONFIG_ROOT is the parent of the per-project config dirs (production: /home/ccd/.claude-projects).

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  LIB=$ROOT/rootfs/usr/local/lib/ccdash
  BIN=$ROOT/rootfs/usr/local/bin
  export HOME=$BATS_TEST_TMPDIR/home
  export CCDASH_WS=$BATS_TEST_TMPDIR/ws
  export CCDASH_TMUX=$BATS_TEST_TMPDIR/tmux.sock
  export CCDASH_STATE=$HOME/.ccdash/sessions
  export CCDASH_PROJECTS=$HOME/.ccdash/projects
  export FAKE_CLAUDE_HOME=$BATS_TEST_TMPDIR/fake
  export FAKE_CLAUDE_SETTINGS=/nonexistent FAKE_CLAUDE_MCP=connected CCDASH_MCP_TIMEOUT=5
  export CCDASH_PROJECT_LIB=$LIB CCDASH_KIT_LIB=$LIB
  export CCDASH_CONFIG_ROOT=$BATS_TEST_TMPDIR/projects
  mkdir -p "$HOME/bin" "$CCDASH_WS/a" "$CCDASH_WS/b" "$CCDASH_STATE" "$CCDASH_PROJECTS" "$FAKE_CLAUDE_HOME"
  # claude wrapper: mcp and `auth status` go to the fake; any other start is logged as "<config dir> <args>" and waits
  printf '#!/bin/bash\nif [ "${1:-}" = mcp ] || [ "${1:-} ${2:-}" = "auth status" ]; then exec %q "$@"; fi\nprintf "%%s\\n" "${CLAUDE_CONFIG_DIR:-unset} $*" >>%q\nsleep 30\n' \
    "$ROOT/tests/fake-claude/claude" "$BATS_TEST_TMPDIR/started" >"$HOME/bin/claude"
  chmod +x "$HOME/bin/claude"
  export PATH=$HOME/bin:$PATH
  printf 'export PATH=%s/bin:$PATH\n' "$HOME" >"$HOME/.bash_profile"
  unset TMUX TMUX_PANE CLAUDE_CONFIG_DIR
  S=$BIN/ccd-session
}

teardown() { tmux -S "$CCDASH_TMUX" kill-server 2>/dev/null || true; }

tm() { tmux -S "$CCDASH_TMUX" "$@"; }
logged_in() { mkdir -p "$FAKE_CLAUDE_HOME/accounts/$1"; : >"$FAKE_CLAUDE_HOME/accounts/$1/logged-in"; }
started() { for _ in $(seq 50); do [ "$(wc -l <"$BATS_TEST_TMPDIR/started" 2>/dev/null || echo 0)" -ge "$1" ] && return 0; sleep 0.1; done; cat "$BATS_TEST_TMPDIR/started" 2>/dev/null; return 1; }

@test "AC-1.1 login opens window 'login' running claude auth login under the project's config dir (0700, owned by the user)" {
  run "$S" login a
  [ "$status" -eq 0 ]
  [ "$(tm list-windows -t =claude-a -F '#{window_name}')" = login ]
  started 1
  grep -qx "$CCDASH_CONFIG_ROOT/a auth login" "$BATS_TEST_TMPDIR/started"
  [ "$(stat -c %a "$CCDASH_CONFIG_ROOT/a")" = 700 ]
  [ "$(stat -c %U "$CCDASH_CONFIG_ROOT/a")" = "$(id -un)" ]
  [ ! -e "$CCDASH_CONFIG_ROOT/b" ]
}

@test "AC-1.1 a second login selects the existing login window instead of adding one" {
  run "$S" login a
  [ "$status" -eq 0 ]
  run "$S" login a
  [ "$status" -eq 0 ]
  [ "$(tm list-windows -t =claude-a | wc -l)" -eq 1 ]
}

@test "AC-1.1 fake claude auth login: prints an https URL, a code on stdin marks the dir logged in" {
  export CLAUDE_CONFIG_DIR=$CCDASH_CONFIG_ROOT/a
  mkdir -p "$CLAUDE_CONFIG_DIR"
  run "$ROOT/tests/fake-claude/claude" auth status
  [ "$status" -eq 1 ]
  run bash -c 'echo code123 | "$1" auth login' _ "$ROOT/tests/fake-claude/claude"
  [ "$status" -eq 0 ]
  [[ $output == *"https://"* ]]
  run "$ROOT/tests/fake-claude/claude" auth status
  [ "$status" -eq 0 ]
}

@test "AC-1.1 login rejects an invalid project name with exit 2" {
  run "$S" login '../a'
  [ "$status" -eq 2 ]
  [[ $output == *"invalid project name"* ]]
  [ ! -e "$CCDASH_CONFIG_ROOT" ]
}

@test "AC-1.1 login for a missing project exits 1 and creates no config dir" {
  run "$S" login nosuch
  [ "$status" -eq 1 ]
  [[ $output == *"no such project"* ]]
  [ ! -e "$CCDASH_CONFIG_ROOT/nosuch" ]
}

@test "AC-1.2 auth prints only logged-in or logged-out, per project" {
  logged_in a
  run "$S" auth a
  [ "$status" -eq 0 ]
  [ "$output" = logged-in ]
  run "$S" auth b
  [ "$output" = logged-out ]
}

@test "AC-1.3 start exits 9 for a logged-out project and creates no claude window" {
  run "$S" start b
  [ "$status" -eq 9 ]
  ! tm has-session -t =claude-b 2>/dev/null
  [ ! -s "$BATS_TEST_TMPDIR/started" ]
}

@test "AC-1.3 start for a logged-in project runs claude with that project's config dir" {
  logged_in a
  run "$S" start a
  [ "$status" -eq 0 ]
  [ "$output" = claude-a ]
  started 1
  grep -q "^$CCDASH_CONFIG_ROOT/a " "$BATS_TEST_TMPDIR/started"
  [ -d "$CCDASH_CONFIG_ROOT/a" ]
}

@test "AC-1.3 two logged-in projects each get their own config dir" {
  logged_in a; logged_in b
  "$S" start a
  "$S" start b
  started 2
  grep -q "^$CCDASH_CONFIG_ROOT/a " "$BATS_TEST_TMPDIR/started"
  grep -q "^$CCDASH_CONFIG_ROOT/b " "$BATS_TEST_TMPDIR/started"
}

@test "AC-1.4 ccd login and ccd accounts are gone: usage, exit 2" {
  export CCDASH_DOCKER=/bin/false
  run "$ROOT/bin/ccd" login
  [ "$status" -eq 2 ]
  [[ $output == usage:* ]]
  [[ $output != *"login"* ]]
  run "$ROOT/bin/ccd" accounts
  [ "$status" -eq 2 ]
  [[ $output != *"accounts"* ]]
}

@test "AC-1.4 ccd-account does not exist" {
  [ ! -e "$BIN/ccd-account" ]
}

@test "AC-1.4 setup.sh has no claude login step" {
  ! grep -Eq 'claude_login|auth login' "$ROOT/setup.sh"
}

@test "AC-1.5 state.sh records project a and no account key" {
  H=$LIB/hooks/state.sh
  jq -nc '{session_id: "aaa", hook_event_name: "Stop", cwd: "/x", transcript_path: "/t"}' |
    CLAUDE_CONFIG_DIR=$CCDASH_CONFIG_ROOT/a CLAUDE_PROJECT_DIR=$CCDASH_WS/a "$H" waiting
  [ "$(jq -r .project "$CCDASH_STATE/aaa.json")" = a ]
  [ "$(jq 'has("account")' "$CCDASH_STATE/aaa.json")" = false ]
}

@test "AC-1.5 statusline.sh records project a and no account key" {
  jq -c '.session_id = "sss"' "$ROOT/tests/fixtures/2.1.317/statusline.json" |
    CLAUDE_CONFIG_DIR=$CCDASH_CONFIG_ROOT/a CLAUDE_PROJECT_DIR=$CCDASH_WS/a "$LIB/hooks/statusline.sh" >/dev/null
  f=$HOME/.ccdash/usage/sss.json
  [ "$(jq -r .project "$f")" = a ]
  [ "$(jq 'has("account")' "$f")" = false ]
}

@test "AC-1.6 ccd-memory-init for project a calls claude with a's config dir" {
  export CCDASH_MEMORY_HOME=$HOME FAKE_CLAUDE_MCP=none
  export CCDASH_BM=$BATS_TEST_TMPDIR/fake-bm
  printf '#!/bin/bash\n[ "$1 $2" = "project list" ] && echo "{\\"projects\\":[{\\"name\\":\\"main\\",\\"is_default\\":true}]}"\nexit 0\n' >"$CCDASH_BM"
  chmod +x "$CCDASH_BM"
  ln -sf "$ROOT/tests/fake-claude/claude" "$HOME/bin/claude"
  run "$BIN/ccd-memory-init" a
  [ "$status" -eq 0 ]
  # the fake keeps mcp state per config dir: accounts/a/mcp-add.log, and nothing in the unscoped home
  grep -q "^mcp add --scope user basic-memory" "$FAKE_CLAUDE_HOME/accounts/a/mcp-add.log"
  [ ! -e "$FAKE_CLAUDE_HOME/mcp-add.log" ]
}

@test "AC-1.6 kit-recheck on opted-in project a runs the kit with a's config dir" {
  LOG=$BATS_TEST_TMPDIR/kit.log
  export CCDASH_KIT_HOME=$BATS_TEST_TMPDIR/kithome CCDASH_LOCK_DIR=$BATS_TEST_TMPDIR/locks CCDASH_KIT_LOCK_WAIT=20
  export KIT_REPO=octo/kit GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com
  export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
  git config --global init.defaultBranch main
  git config --global protocol.file.allow always
  # project a: bare origin, checkout in the workspace, opted in (same setup as kit-recheck.bats)
  b=$BATS_TEST_TMPDIR/a.git w=$BATS_TEST_TMPDIR/a.w
  git init -q --bare "$b"; git --git-dir="$b" symbolic-ref HEAD refs/heads/main
  git clone -q "$b" "$w" 2>/dev/null; echo x >"$w/f"; git -C "$w" add f; git -C "$w" commit -qm one; git -C "$w" push -q origin HEAD:main
  git config --global url."$b".insteadOf "https://github.com/octo/a.git"
  git clone -q "$b" "$CCDASH_WS/a" 2>/dev/null
  git -C "$CCDASH_WS/a" remote set-url origin "https://github.com/octo/a.git"
  printf '%s\n' '{"repo":"octo/a","kitEnabled":true}' >"$CCDASH_PROJECTS/a.json"
  # kit stub: logs its CLAUDE_CONFIG_DIR, then behaves like the agent-kit stub
  printf '#!/bin/bash\necho "$0 ${CLAUDE_CONFIG_DIR:-unset}" >>%q\nexec %q "$@"\n' "$LOG" "$ROOT/tests/fixtures/agent-kit-stub.sh" >"$BATS_TEST_TMPDIR/kitstub"
  chmod +x "$BATS_TEST_TMPDIR/kitstub"
  export CCDASH_KIT=$BATS_TEST_TMPDIR/kitstub
  run "$S" kit-recheck
  [ "$status" -eq 0 ]
  grep -q " $CCDASH_CONFIG_ROOT/a\$" "$LOG"
  ! grep -q " unset\$" "$LOG"
}
