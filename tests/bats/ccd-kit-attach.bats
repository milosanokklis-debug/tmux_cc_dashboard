#!/usr/bin/env bats
# ccd-kit update / update --reset re-register the kit marketplace per project config dir before re-checking projects.
# Fake `claude` on PATH logs "<CLAUDE_CONFIG_DIR or unset>|<args>" to CALLS; the kit stub logs "KITRUN" there too.

setup() {
  export CCDASH_MEMORY_INIT=/bin/true
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  BIN=$ROOT/rootfs/usr/local/bin
  export HOME=$BATS_TEST_TMPDIR/home
  export CCDASH_WS=$BATS_TEST_TMPDIR/ws CCDASH_PROJECTS=$HOME/.ccdash/projects
  export CCDASH_KIT_HOME=$BATS_TEST_TMPDIR/kithome CCDASH_LOCK_DIR=$BATS_TEST_TMPDIR/locks
  export CCDASH_KIT_IMAGE=$BATS_TEST_TMPDIR/image KIT_REPO=octo/kit CCDASH_KIT_LOCK_WAIT=20
  export CCDASH_KIT_LIB=$ROOT/rootfs/usr/local/lib/ccdash CCDASH_PROJECT_LIB=$ROOT/rootfs/usr/local/lib/ccdash
  export CCDASH_CONFIG_ROOT=$BATS_TEST_TMPDIR/projects STUB_LOG=$BATS_TEST_TMPDIR/stub.log
  export CALLS=$BATS_TEST_TMPDIR/calls.log
  unset STUB_EXIT STUB_VERSION STUB_MEMORY STUB_SECRET CLAUDE_CONFIG_DIR FAKE_ADD_FAIL_FOR
  export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
  mkdir -p "$HOME/bin" "$CCDASH_WS" "$CCDASH_PROJECTS" "$CCDASH_CONFIG_ROOT/work" "$CCDASH_CONFIG_ROOT/alt"
  : > "$CALLS"
  git config --global init.defaultBranch main
  git config --global protocol.file.allow always
  # fake claude: log config dir + args; fail `plugin marketplace add` when the config dir ends in $FAKE_ADD_FAIL_FOR
  cat > "$HOME/bin/claude" <<'SH'
#!/bin/bash
echo "${CLAUDE_CONFIG_DIR:-unset}|$*" >> "$CALLS"
if [ "${1:-}" = plugin ] && [ "${2:-}" = marketplace ] && [ "${3:-}" = add ] && [ -n "${FAKE_ADD_FAIL_FOR:-}" ] && [[ ${CLAUDE_CONFIG_DIR:-} == *"/$FAKE_ADD_FAIL_FOR" ]]; then
  echo "marketplace add failed" >&2; exit 1
fi
exit 0
SH
  chmod +x "$HOME/bin/claude"
  export PATH=$HOME/bin:$PATH
  printf '#!/bin/bash\necho KITRUN >> %q\nexec %q "$@"\n' "$CALLS" "$ROOT/tests/fixtures/agent-kit-stub.sh" > "$BATS_TEST_TMPDIR/kitstub"
  chmod +x "$BATS_TEST_TMPDIR/kitstub"
  export CCDASH_KIT=$BATS_TEST_TMPDIR/kitstub
  # image kit (with a marketplace manifest)
  mkdir -p "$CCDASH_KIT_IMAGE/.claude-plugin"; git init -q "$CCDASH_KIT_IMAGE"
  { cat "$ROOT/tests/fixtures/agent-kit-stub.sh"; echo 'KIT_VERSION="0.0.1"'; } > "$CCDASH_KIT_IMAGE/agent-kit.sh"
  chmod +x "$CCDASH_KIT_IMAGE/agent-kit.sh"
  echo '{"name":"acme-kit","plugins":[]}' > "$CCDASH_KIT_IMAGE/.claude-plugin/marketplace.json"
  git -C "$CCDASH_KIT_IMAGE" add -A; git -C "$CCDASH_KIT_IMAGE" commit -qm image
  IMG=$(git -C "$CCDASH_KIT_IMAGE" rev-parse HEAD)
  # upstream kit repo
  KBARE=$BATS_TEST_TMPDIR/kit.git; KW=$BATS_TEST_TMPDIR/kitw
  git init -q --bare "$KBARE"; git --git-dir="$KBARE" symbolic-ref HEAD refs/heads/main
  git clone -q "$KBARE" "$KW" 2> /dev/null
  git config --global url."$KBARE".insteadOf https://github.com/octo/kit
  mkdir -p "$KW/.claude-plugin"
  { cat "$ROOT/tests/fixtures/agent-kit-stub.sh"; echo 'KIT_VERSION="1.2.3"'; } > "$KW/agent-kit.sh"
  chmod +x "$KW/agent-kit.sh"
  echo '{"name":"acme-kit","plugins":[]}' > "$KW/.claude-plugin/marketplace.json"
  git -C "$KW" add -A; git -C "$KW" commit -qm v1; git -C "$KW" push -q origin HEAD:main
  TIP=$(git -C "$KW" rev-parse HEAD)
  # one opted-in project (its own config dir is not in the list yet)
  local b=$BATS_TEST_TMPDIR/demo.git w=$BATS_TEST_TMPDIR/demo.w
  git init -q --bare "$b"; git --git-dir="$b" symbolic-ref HEAD refs/heads/main
  git clone -q "$b" "$w" 2> /dev/null; echo x > "$w/f"; git -C "$w" add f; git -C "$w" commit -qm one; git -C "$w" push -q origin HEAD:main
  git config --global url."$b".insteadOf "https://github.com/octo/demo.git"
  git clone -q "$b" "$CCDASH_WS/demo" 2> /dev/null
  git -C "$CCDASH_WS/demo" remote set-url origin "https://github.com/octo/demo.git"
  printf '%s\n' '{"repo":"octo/demo","kitEnabled":true}' > "$CCDASH_PROJECTS/demo.json"
}

teardown() { chmod -R u+w "$BATS_TEST_TMPDIR" 2> /dev/null || true; }

adds() { grep -F '|plugin marketplace add ' "$CALLS" || true; }

@test "AC-3.1 update re-adds the new kit checkout as marketplace for each project config dir, before any project line" {
  run "$BIN/ccd-kit" update
  [ "$status" -eq 0 ]
  grep -qxF "$CCDASH_CONFIG_ROOT/work|plugin marketplace add $CCDASH_KIT_HOME/$TIP" "$CALLS"
  grep -qxF "$CCDASH_CONFIG_ROOT/alt|plugin marketplace add $CCDASH_KIT_HOME/$TIP" "$CALLS"
  # every add happens before the project re-check runs the kit
  last_add=$(grep -nF '|plugin marketplace add ' "$CALLS" | tail -n1 | cut -d: -f1)
  first_kit=$(grep -n '^KITRUN$' "$CALLS" | head -n1 | cut -d: -f1)
  [ -n "$last_add" ] && [ -n "$first_kit" ] && [ "$last_add" -lt "$first_kit" ]
  # stdout contract
  [[ ${lines[0]} == "project demo "* ]]
  [ "${lines[-2]}" = "updated $IMG $TIP" ]
  [ "${lines[-1]}" = "version 0.0.1 1.2.3" ]
}

@test "AC-3.2 update --reset re-adds the marketplace from CCDASH_KIT_IMAGE for each project config dir" {
  run "$BIN/ccd-kit" update --reset
  [ "$status" -eq 0 ]
  grep -qxF "$CCDASH_CONFIG_ROOT/work|plugin marketplace add $CCDASH_KIT_IMAGE" "$CALLS"
  grep -qxF "$CCDASH_CONFIG_ROOT/alt|plugin marketplace add $CCDASH_KIT_IMAGE" "$CALLS"
  [ "${lines[-2]}" = "updated $IMG $IMG" ]
  [ "${lines[-1]}" = "version 0.0.1 0.0.1" ]
}

@test "AC-3.3 no registration points at the pruned old checkout" {
  run "$BIN/ccd-kit" update
  [ "$status" -eq 0 ]
  mkdir -p "$CCDASH_KIT_HOME"
  # a third, older checkout gets pruned by the next update: registrations must only name existing dirs
  git -C "$KW" commit -q --allow-empty -m v2; git -C "$KW" push -q origin HEAD:main
  NEW=$(git -C "$KW" rev-parse HEAD)
  git -C "$KW" commit -q --allow-empty -m v3; git -C "$KW" push -q origin HEAD:main
  : > "$CALLS"
  run "$BIN/ccd-kit" update
  [ "$status" -eq 0 ]
  NEWEST=$(git -C "$KW" rev-parse HEAD)
  [ ! -d "$CCDASH_KIT_HOME/$NEW" ] || true
  [ -n "$(adds)" ]
  while IFS= read -r l; do
    p=${l##*|plugin marketplace add }
    [ -d "$p" ]
  done < <(adds)
  grep -qxF "$CCDASH_CONFIG_ROOT/work|plugin marketplace add $CCDASH_KIT_HOME/$NEWEST" "$CALLS"
  grep -qxF "$CCDASH_CONFIG_ROOT/alt|plugin marketplace add $CCDASH_KIT_HOME/$NEWEST" "$CALLS"
}

@test "AC-3.3 a failing add for one project still lets the other project dir and the project re-check run" {
  FAKE_ADD_FAIL_FOR=work run "$BIN/ccd-kit" update
  [ "$status" -eq 0 ]
  grep -qxF "$CCDASH_CONFIG_ROOT/work|plugin marketplace add $CCDASH_KIT_HOME/$TIP" "$CALLS"
  grep -qxF "$CCDASH_CONFIG_ROOT/alt|plugin marketplace add $CCDASH_KIT_HOME/$TIP" "$CALLS"
  grep -q '^KITRUN$' "$CALLS"
  [[ ${lines[0]} == "project demo "* ]]
  [ "${lines[-2]}" = "updated $IMG $TIP" ]
  [ "${lines[-1]}" = "version 0.0.1 1.2.3" ]
}
