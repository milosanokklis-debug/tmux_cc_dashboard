#!/usr/bin/env bats
# Agent-kit step of ccd-onboard, the rebase in ccd-project pull and the hook-gate exemption.
# Local bare repos (insteadOf), no network; the kit is tests/fixtures/agent-kit-stub.sh (same `ensure` contract
# as the real kit). The real kit is only touched by the last test, which skips when it or `claude` is absent.

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  BIN=$ROOT/rootfs/usr/local/bin
  export HOME=$BATS_TEST_TMPDIR/home
  export CCDASH_WS=$BATS_TEST_TMPDIR/ws
  export CCDASH_PROJECTS=$BATS_TEST_TMPDIR/home/.ccdash/projects
  export CCDASH_KIT=$ROOT/tests/fixtures/agent-kit-stub.sh KIT_REPO=octo/kit
  export STUB_LOG=$BATS_TEST_TMPDIR/stub.log
  unset STUB_EXIT STUB_VERSION STUB_MEMORY STUB_SECRET
  export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
  mkdir -p "$HOME" "$CCDASH_WS"
  git config --global init.defaultBranch main
  git config --global protocol.file.allow always
  BARE=$BATS_TEST_TMPDIR/demo.git
  git init -q --bare "$BARE"
  W=$BATS_TEST_TMPDIR/seed
  git clone -q "$BARE" "$W" 2>/dev/null
  echo one > "$W/f"; git -C "$W" add f; git -C "$W" commit -qm one; git -C "$W" push -q origin HEAD:main
  git --git-dir="$BARE" symbolic-ref HEAD refs/heads/main
  git config --global url."$BARE".insteadOf https://github.com/octo/demo.git
  D=$CCDASH_WS/demo
  REC=$CCDASH_PROJECTS/demo.json
}

push_commit() { git -C "$W" pull -q origin main 2>/dev/null; echo "$1" > "$W/f"; git -C "$W" commit -qam "$1"; git -C "$W" push -q origin HEAD:main; }
# everything that matters about a checkout: HEAD, status (ignored files too), and every file's hash
state() {
  git -C "$D" rev-parse HEAD
  git -C "$D" status --porcelain --ignored
  (cd "$D" && find . -path ./.git -prune -o -type f -print | sort | xargs sha256sum)
}
subjects() { git -C "$D" log --format=%s; }

@test "fresh onboard: one chore commit by ccdash with only .claude/ and CLAUDE.md; record has kit and packs" {
  run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 0 ]
  [[ $output == *"kit 0.9.2 changed"* ]]
  [[ $output == *"packs kit-core,kit-design,kit-code"* ]]
  [[ $output == *"memory connected"* ]]
  [ "${lines[-1]}" = "head $(git -C "$D" rev-parse HEAD)" ]
  [ "$(git -C "$D" rev-list --count HEAD)" -eq 2 ]
  [ "$(git -C "$D" log -1 --format='%an <%ae>|%cn <%ce>|%s')" = 'ccdash <ccdash@localhost>|ccdash <ccdash@localhost>|chore: agent-kit 0.9.2' ]
  [ "$(git -C "$D" diff-tree --no-commit-id --name-only -r HEAD | paste -sd' ')" = ".claude/agent-kit.json .claude/settings.json CLAUDE.md" ]
  [ -z "$(git -C "$D" status --porcelain)" ]
  [ "$(git --git-dir="$BARE" rev-parse main)" = "$(git -C "$W" rev-parse HEAD)" ] # never pushed
  [ "$(jq -c .kit "$REC")" = '{"version":"0.9.2","packs":["kit-core","kit-design","kit-code"],"memory":"connected"}' ]
  [ "$(jq -c .packs "$REC")" = '["kit-core","kit-design","kit-code"]' ]
  [ "$(jq -r .kitEnabled "$REC")" = true ]
  [ "$(jq -r .head "$REC")" = "$(git -C "$D" rev-parse HEAD)" ]
  [ "$(jq -r 'has("kitError")' "$REC")" = false ]
  grep -q "args=ensure $D design code --json NO_COLOR=1 TMPDIR=/tmp KIT_REPO=octo/kit" "$STUB_LOG"
  [ -s "$HOME/.ccdash/kit-demo.log" ]
}

@test "second onboard: nothing changes, no commit, tree clean" {
  "$BIN/ccd-onboard" --kit octo/demo
  before=$(state)
  run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 0 ]
  [[ $output == *"kit 0.9.2 unchanged"* ]]
  [ "$(state)" = "$before" ]
  [ "$(git -C "$D" rev-list --count HEAD)" -eq 2 ]
}

@test "kit paths already dirty: the kit runs but its commit is skipped" {
  "$BIN/ccd-onboard" --kit octo/demo
  head=$(git -C "$D" rev-parse HEAD)
  echo mine >> "$D/CLAUDE.md"
  STUB_VERSION=1.2.3 run "$BIN/ccd-onboard" --kit-only octo/demo
  [ "$status" -eq 0 ]
  [ "$(git -C "$D" rev-parse HEAD)" = "$head" ]
  [ "$(git -C "$D" log -1 --format=%s)" != "chore: agent-kit 1.2.3" ]
  [ -n "$(git -C "$D" status --porcelain -- .claude CLAUDE.md)" ]
}

@test "memory missing and a different version are recorded" {
  STUB_MEMORY=missing STUB_VERSION=1.2.3 run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 0 ]
  [[ $output == *"memory missing"* ]]
  [ "$(git -C "$D" log -1 --format=%s)" = "chore: agent-kit 1.2.3" ]
  [ "$(jq -c .kit "$REC")" = '{"version":"1.2.3","packs":["kit-core","kit-design","kit-code"],"memory":"missing"}' ]
}

@test "default is off: a clone without --kit runs no kit, writes no .claude or CLAUDE.md, record kitEnabled false" {
  run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 0 ]
  [[ $output == *"kit off"* ]]
  [ ! -s "$STUB_LOG" ]
  [ ! -e "$D/.claude" ] && [ ! -e "$D/CLAUDE.md" ]
  [ "$(git -C "$D" rev-list --count HEAD)" -eq 1 ]
  [ "$(jq -r .kitEnabled "$REC")" = false ]
  [ "$(jq -r 'has("kit")' "$REC")" = false ]
}

@test "--kit runs ensure with design code; a later pull without a flag keeps it on; --no-kit stops and leaves files" {
  run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 0 ]
  grep -q "args=ensure $D design code --json" "$STUB_LOG"
  [ "$(jq -c .packs "$REC")" = '["kit-core","kit-design","kit-code"]' ]
  [ "$(jq -r .kitEnabled "$REC")" = true ]
  [ -f "$D/.claude/skills/web-design-guidelines/SKILL.md" ]
  [ -z "$(git -C "$D" status --porcelain)" ]
  run "$BIN/ccd-onboard" octo/demo # no flag: the record decides
  [ "$status" -eq 0 ]
  [[ $output == *"kit 0.9.2 unchanged"* ]]
  [ "$(grep -c '^args=' "$STUB_LOG")" -eq 2 ]
  before=$(state); : > "$STUB_LOG"
  run "$BIN/ccd-onboard" --no-kit octo/demo
  [ "$status" -eq 0 ]
  [[ $output == *"kit off"* ]]
  [ ! -s "$STUB_LOG" ]
  [ "$(state)" = "$before" ] # files stay: agent-kit has no remove command
  [ "$(jq -r .kitEnabled "$REC")" = false ]
  [ "$(jq -c .packs "$REC")" = '["kit-core","kit-design","kit-code"]' ] # describes what is left on disk
  run "$BIN/ccd-onboard" octo/demo # still off without a flag
  [ ! -s "$STUB_LOG" ]
}

@test "an old record with a kit entry and no kitEnabled migrates to enabled on pull" {
  "$BIN/ccd-onboard" octo/demo
  jq -c '.kit = {version: "0.9.0", packs: ["kit-core"], memory: "connected"} | del(.kitEnabled)' "$REC" > "$REC.n"; mv "$REC.n" "$REC"
  run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 0 ]
  grep -q "args=ensure $D design code --json" "$STUB_LOG"
  [ "$(jq -r .kitEnabled "$REC")" = true ]
  [ "$(jq -c .packs "$REC")" = '["kit-core","kit-design","kit-code"]' ]
}

@test "the exemption follows the active kit's UPSTREAM_MARKETPLACES and falls back to the 0.9.2 list" {
  export CCDASH_KIT= KIT_HOME=$BATS_TEST_TMPDIR/kithome
  export CCDASH_KIT_HOME=$KIT_HOME
  "$BIN/ccd-onboard" octo/demo
  add_settings agent-kit.json '{"kit_version":"1"}'
  add_settings settings.json '{"extraKnownMarketplaces":{"extra":{"source":{"source":"github","repo":"Foo/extra-skills"}}}}'
  run "$BIN/ccd-project" pull demo # no active kit dir: 0.9.2 list, Foo/extra-skills is unknown
  [ "$status" -eq 5 ]
  mkdir -p "$KIT_HOME/current"
  printf '#!/usr/bin/env bash\nUPSTREAM_MARKETPLACES=(\n  "extra=Foo/extra-skills"\n  "hallmark=Nutlope/hallmark"\n)\n' > "$KIT_HOME/current/agent-kit.sh"
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 0 ]
  printf '#!/usr/bin/env bash\necho no array here\n' > "$KIT_HOME/current/agent-kit.sh" # falls back again
  add_settings settings.json '{"extraKnownMarketplaces":{"hallmark":{"source":{"source":"github","repo":"Nutlope/hallmark"}}},"enabledPlugins":{"hallmark@hallmark":true}}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 0 ]
}

@test "kit.sh: kit_script prefers current when it has agent-kit.sh, else /opt/agent-kit" {
  . "$ROOT/rootfs/usr/local/lib/ccdash/kit.sh"
  export CCDASH_KIT_HOME=$BATS_TEST_TMPDIR/kh
  [ "$(kit_script)" = /opt/agent-kit/agent-kit.sh ]
  mkdir -p "$CCDASH_KIT_HOME/current"; : > "$CCDASH_KIT_HOME/current/agent-kit.sh"
  [ "$(kit_script)" = "$CCDASH_KIT_HOME/current/agent-kit.sh" ]
}

@test "kit.sh: rows are validated; an empty array falls back to the 0.9.2 list" {
  . "$ROOT/rootfs/usr/local/lib/ccdash/kit.sh"
  export CCDASH_KIT_HOME=$BATS_TEST_TMPDIR/kh
  mkdir -p "$CCDASH_KIT_HOME/current"
  printf 'UPSTREAM_MARKETPLACES=(\n  "a-b=o/r.x"\n  "bad row"\n  "x=y"\n)\n' > "$CCDASH_KIT_HOME/current/agent-kit.sh"
  [ "$(kit_upstream_marketplaces)" = "a-b=o/r.x" ]
  : > "$CCDASH_KIT_HOME/current/agent-kit.sh"
  [ "$(kit_upstream_marketplaces | wc -l)" -eq 5 ]
}

@test "kit.sh: an unterminated UPSTREAM_MARKETPLACES array gives the fallback; a later x=evil/repo line is not read" {
  . "$ROOT/rootfs/usr/local/lib/ccdash/kit.sh"
  export CCDASH_KIT_HOME=$BATS_TEST_TMPDIR/kh
  mkdir -p "$CCDASH_KIT_HOME/current"
  printf 'UPSTREAM_MARKETPLACES=(\n  "a=b/c"\nx=evil/repo\n' > "$CCDASH_KIT_HOME/current/agent-kit.sh"
  [ "$(kit_upstream_marketplaces | wc -l)" -eq 5 ]
  ! kit_upstream_marketplaces | grep -q evil
  ! kit_upstream_marketplaces | grep -q 'a=b/c'
}

@test "kit.sh: commented rows and trailing comments are ignored; the one-line form is read" {
  . "$ROOT/rootfs/usr/local/lib/ccdash/kit.sh"
  export CCDASH_KIT_HOME=$BATS_TEST_TMPDIR/kh
  mkdir -p "$CCDASH_KIT_HOME/current"
  printf 'UPSTREAM_MARKETPLACES=(\n  # "hidden=o/r"\n  "keep=o/r"   # "trailing=o/r" )\n  "tail=o/r" # )\n)\n' > "$CCDASH_KIT_HOME/current/agent-kit.sh"
  [ "$(kit_upstream_marketplaces)" = "$(printf 'keep=o/r\ntail=o/r')" ]
  printf 'UPSTREAM_MARKETPLACES=(a=b/c d=e/f)\n' > "$CCDASH_KIT_HOME/current/agent-kit.sh"
  [ "$(kit_upstream_marketplaces)" = "$(printf 'a=b/c\nd=e/f')" ]
}

@test "ccd kit on/off/status and clone flags pass through to the container" {
  TD=$BATS_TEST_TMPDIR/dk; mkdir -p "$TD"
  printf '#!/usr/bin/env bash\necho "$@" >> %s/calls\n' "$TD" > "$TD/docker"; chmod +x "$TD/docker"
  export CCDASH_DOCKER=$TD/docker
  run "$ROOT/bin/ccd" clone --trust-hooks --kit octo/demo
  [ "$status" -eq 0 ]
  grep -q 'ccd-onboard --trust-hooks --kit octo/demo' "$TD/calls"
  run "$ROOT/bin/ccd" clone --bogus octo/demo
  [ "$status" -eq 2 ]
  run "$ROOT/bin/ccd" kit on '../x'
  [ "$status" -eq 2 ]
  run "$ROOT/bin/ccd" kit status
  [ "$status" -eq 0 ]
  grep -q 'sh -c' "$TD/calls"
}

@test "ccd kit status shows kitEnabled false even with a kit entry, and strips control chars from the error" {
  mkdir -p "$HOME/.ccdash/projects"
  jq -n '{repo: "octo/demo", kit: {version: "0.9.2"}, kitEnabled: false, kitError: {code: 4, message: "bad\u001b[31m msg"}}' > "$HOME/.ccdash/projects/demo.json"
  TD=$BATS_TEST_TMPDIR/dk; mkdir -p "$TD"
  printf '#!/usr/bin/env bash\nwhile [ "$1" != ccdash ]; do shift; done; shift; exec "$@"\n' > "$TD/docker"; chmod +x "$TD/docker"
  export CCDASH_DOCKER=$TD/docker
  run "$ROOT/bin/ccd" kit status
  [ "$status" -eq 0 ]
  [ "$output" = "demo  kit=false  version=0.9.2  error=4 bad[31m msg" ]
}

@test "kit exit 2..6: message printed, exit 8, repo exactly as it was, no commit, record only gets kitError" {
  declare -A msg=([2]="Kit usage error" [3]="Kit prerequisite missing" [4]="Kit marketplace failed (network?)" [5]="Plugin install or update failed" [6]="Could not write project files")
  "$BIN/ccd-onboard" --kit octo/demo
  before=$(state)
  for n in 2 3 4 5 6; do
    STUB_EXIT=$n run "$BIN/ccd-onboard" --kit octo/demo
    [ "$status" -eq 8 ]
    [[ $output == *"kit-error $n ${msg[$n]}"* ]]
    [[ $output == *"stub: scribbling"* ]] # the log tail follows
    [ "$(state)" = "$before" ]
    [ "$(jq -r .kitError.code "$REC")" = "$n" ]
    [ "$(jq -c .kit "$REC")" = '{"version":"0.9.2","packs":["kit-core","kit-design","kit-code"],"memory":"connected"}' ] # last good kit state kept
  done
  [[ $(STUB_EXIT=4 "$BIN/ccd-onboard" --kit octo/demo) == *"retry"* ]]
  [[ $(STUB_EXIT=5 "$BIN/ccd-onboard" --kit octo/demo) == *"retry"* ]]
  run "$BIN/ccd-onboard" --kit octo/demo # recovers, and clears the error
  [ "$status" -eq 0 ]
  [ "$(jq -r 'has("kitError")' "$REC")" = false ]
}

@test "kit failure on a fresh clone keeps the clone untouched past the clone" {
  STUB_EXIT=4 run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 8 ]
  [ "$(git -C "$D" rev-parse HEAD)" = "$(git -C "$W" rev-parse HEAD)" ]
  [ -z "$(git -C "$D" status --porcelain --ignored)" ]
  [ ! -e "$D/.claude" ]
  [ ! -e "$D/CLAUDE.md" ]
  [ "$(jq -r .kitError.code "$REC")" = 4 ]
  [ "$(jq -r 'has("kit")' "$REC")" = false ]
}

@test "kit failure restores user files the kit had modified, and leaves other untracked-ignored files alone" {
  mkdir -p "$W/.claude"
  echo '{"permissions":{"allow":["Read"]}}' > "$W/.claude/settings.json"
  printf '# mine\n' > "$W/CLAUDE.md"
  printf '.claude/settings.local.json\n' > "$W/.gitignore"
  git -C "$W" add -A; git -C "$W" commit -qm project; git -C "$W" push -q origin HEAD:main
  STUB_EXIT=3 run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 8 ]
  echo keepme > "$D/.claude/settings.local.json"
  before=$(state)
  STUB_EXIT=6 run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 8 ]
  [ "$(state)" = "$before" ]
  [ "$(cat "$D/CLAUDE.md")" = "# mine" ]
  [ "$(cat "$D/.claude/settings.local.json")" = keepme ]
}

@test "pull after the remote gains a commit rebases the kit commit on top" {
  "$BIN/ccd-onboard" --kit octo/demo
  old_kit=$(git -C "$D" rev-parse HEAD)
  push_commit two
  run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 0 ]
  [[ $output == *rebased* ]]
  new_kit=$(git -C "$D" rev-parse HEAD)
  [ "$new_kit" != "$old_kit" ]
  [ "$(git -C "$D" rev-parse HEAD~1)" = "$(git -C "$W" rev-parse HEAD)" ]
  [ "$(git -C "$D" log -1 --format='%ae|%s')" = 'ccdash@localhost|chore: agent-kit 0.9.2' ]
  [ "$(cat "$D/f")" = two ]
  [ -z "$(git -C "$D" status --porcelain)" ]
  [ "$(git -C "$D" rev-list --count HEAD)" -eq 3 ]
  [ "$(jq -r .head "$REC")" = "$new_kit" ]
}

@test "pull refuses to rebase a hand-made local commit (other author), HEAD unchanged" {
  "$BIN/ccd-onboard" --kit octo/demo
  echo mine > "$D/g"; git -C "$D" add g; git -C "$D" commit -qm mine
  push_commit two
  before=$(state)
  run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 3 ]
  [[ $output == *"local commits not from ccdash"* ]]
  [ "$(state)" = "$before" ]
}

@test "pull refuses a ccdash-authored local commit that touches other paths" {
  "$BIN/ccd-onboard" --kit octo/demo
  echo mine > "$D/g"; git -C "$D" add g
  GIT_AUTHOR_EMAIL=ccdash@localhost git -C "$D" commit -qm sneaky
  push_commit two
  before=$(state)
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 3 ]
  [[ $output == *"local commits not from ccdash"* ]]
  [ "$(state)" = "$before" ]
}

@test "a rebase conflict is aborted: 'rebase failed', exit 3, repo as before" {
  "$BIN/ccd-onboard" --kit octo/demo
  git -C "$W" pull -q origin main
  echo remote > "$W/CLAUDE.md"; git -C "$W" add CLAUDE.md; git -C "$W" commit -qm claude; git -C "$W" push -q origin HEAD:main
  before=$(state)
  run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 3 ]
  [[ $output == *"rebase failed"* ]]
  [ "$(state)" = "$before" ]
  [ ! -e "$D/.git/rebase-merge" ]
  [ ! -e "$D/.git/rebase-apply" ]
}

@test "diverged with only non-kit local work keeps the Phase D message" {
  "$BIN/ccd-onboard" --kit octo/demo
  push_commit two
  echo l > "$D/g"; git -C "$D" add g; git -C "$D" commit -qm local
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 3 ]
  [[ $output == *"demo has diverged from origin"* ]]
}

# ---- hook gate ----------------------------------------------------------------------------------------------
add_settings() { # add_settings <file> <json>
  git -C "$W" pull -q origin main 2>/dev/null
  mkdir -p "$W/.claude"; rm -f "$W/.claude/$1"; printf '%s\n' "$2" > "$W/.claude/$1"
  git -C "$W" add .claude; git -C "$W" commit -qm "settings $1"; git -C "$W" push -q origin HEAD:main
}
KITSET='{"extraKnownMarketplaces":{"agent-kit":{"source":{"source":"github","repo":"octo/kit"}}},"enabledPlugins":{"kit-core@agent-kit":true}}'

@test "a repo with its own hooks is still refused (exit 5) and the kit never runs" {
  add_settings settings.json '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"evil"}]}]}}'
  run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 5 ]
  [[ $output == *"hooks: Stop"* ]]
  [ ! -e "$D" ]
  [ ! -e "$STUB_LOG" ]
}

@test "the kit's own committed settings do not trip the gate: pull and fresh clone" {
  "$BIN/ccd-onboard" --kit octo/demo
  git -C "$D" push -q origin HEAD:main # a user pushes the kit commit
  push_commit two
  run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 0 ]
  [ "$(git -C "$D" rev-parse HEAD)" = "$(git -C "$W" rev-parse HEAD)" ]
  rm -rf "$D" "$CCDASH_PROJECTS"
  run "$BIN/ccd-onboard" --kit octo/demo # fresh clone of a repo that already carries the kit
  [ "$status" -eq 0 ]
  [ "$(git -C "$D" rev-list --count HEAD)" -eq "$(git -C "$W" rev-list --count HEAD)" ] # unchanged, no new commit
}

@test "enabledPlugins/extraKnownMarketplaces are still refused without agent-kit.json, with a foreign repo, extra fields or next to hooks" {
  export CCDASH_KIT= # gate only: no kit commit of our own to conflict with
  "$BIN/ccd-onboard" --kit octo/demo
  before=$(git -C "$D" rev-parse HEAD)
  add_settings settings.json "$KITSET" # no agent-kit.json
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  [[ $output == *"hooks: enabledPlugins,extraKnownMarketplaces"* ]]
  [ "$(git -C "$D" rev-parse HEAD)" = "$before" ]
  add_settings agent-kit.json '{"kit_version":"1"}'
  run "$BIN/ccd-project" pull demo # now exempt
  [ "$status" -eq 0 ]
  git -C "$D" reset -q --hard "$before"
  add_settings settings.json '{"extraKnownMarketplaces":{"agent-kit":{"source":{"source":"github","repo":"evil/market"}}},"enabledPlugins":{"kit-core@agent-kit":true}}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  [[ $output == *"hooks: enabledPlugins,extraKnownMarketplaces"* ]]
  add_settings settings.json '{"extraKnownMarketplaces":{"agent-kit":{"source":{"source":"github","repo":"octo/kit"},"x":1}},"enabledPlugins":{"kit-core@agent-kit":true}}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  add_settings settings.json '{"extraKnownMarketplaces":{"agent-kit":{"source":{"source":"github","repo":"octo/kit"}}},"enabledPlugins":{"kit-core@other":true}}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  add_settings settings.json '{"extraKnownMarketplaces":{"agent-kit":{"source":{"source":"github","repo":"octo/kit"}}},"enabledPlugins":{"kit-core@agent-kit":true},"hooks":{"Stop":[]},"env":{"A":"b"}}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  [[ $output == *Stop* ]]
  [[ $output == *env* ]]
  [[ $output != *enabledPlugins* ]] # the kit keys themselves are not what is flagged
  [ "$(git -C "$D" rev-parse HEAD)" = "$before" ]
}

@test "a plugin the kit does not write is refused even under an allowlisted marketplace; the exact upstream ones pass" {
  export CCDASH_KIT=
  "$BIN/ccd-onboard" --kit octo/demo
  before=$(git -C "$D" rev-parse HEAD)
  add_settings agent-kit.json '{"kit_version":"1"}'
  add_settings settings.json '{"extraKnownMarketplaces":{"agent-kit":{"source":{"source":"github","repo":"octo/kit"}}},"enabledPlugins":{"evil@agent-kit":true}}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  [[ $output == *enabledPlugins* ]]
  add_settings settings.json '{"extraKnownMarketplaces":{"agent-kit":{"source":{"source":"github","repo":"octo/kit"}},"hallmark":{"source":{"source":"github","repo":"Nutlope/hallmark"}}},"enabledPlugins":{"kit-core@agent-kit":true,"hallmark@hallmark":true}}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 0 ]
  git -C "$D" reset -q --hard "$before"
  add_settings settings.json '{"extraKnownMarketplaces":{"agent-kit":{"source":{"source":"github","repo":"octo/kit"}},"hallmark":{"source":{"source":"github","repo":"Nutlope/hallmark"}}},"enabledPlugins":{"kit-core@agent-kit":true,"other@hallmark":true}}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
}

@test "agent-kit.json must be a regular file holding an object with kit_version" {
  export CCDASH_KIT=
  "$BIN/ccd-onboard" --kit octo/demo
  before=$(git -C "$D" rev-parse HEAD)
  add_settings settings.json "$KITSET"
  git -C "$W" pull -q origin main 2>/dev/null
  ln -s settings.json "$W/.claude/agent-kit.json" # a symlink, even to valid JSON
  git -C "$W" add .claude; git -C "$W" commit -qm link; git -C "$W" push -q origin HEAD:main
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  git -C "$D" reset -q --hard "$before"
  add_settings agent-kit.json '[1]'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  git -C "$D" reset -q --hard "$before"
  add_settings agent-kit.json '{"kit_version":1}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  [ "$(git -C "$D" rev-parse HEAD)" = "$before" ]
}

@test "a symlinked .claude: kit step refused with 'Could not write project files', exit 8, nothing changed" {
  mkdir -p "$W/elsewhere"; echo '{}' > "$W/elsewhere/settings.json"; ln -s elsewhere "$W/.claude"
  git -C "$W" add .; git -C "$W" commit -qm link; git -C "$W" push -q origin HEAD:main
  run "$BIN/ccd-onboard" --trust-hooks --kit octo/demo
  [ "$status" -eq 8 ]
  [[ $output == *"kit-error 6 Could not write project files"* ]]
  [ -L "$D/.claude" ]
  [ "$(cat "$D/elsewhere/settings.json")" = '{}' ]
  [ ! -e "$D/elsewhere/agent-kit.json" ]
  [ -z "$(git -C "$D" status --porcelain)" ]
  [ ! -e "$STUB_LOG" ]
}

@test "the kit log shown on failure is a redacted tail, and the log file is owner-only" {
  STUB_SECRET=hunter2hunter2 STUB_EXIT=5 run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 8 ]
  [[ $output == *"token=***"* ]]
  [[ $output == *"Bearer ***"* ]]
  [[ $output != *hunter2* ]]
  [ "$(stat -c %a "$HOME/.ccdash/kit-demo.log")" = 600 ]
}

@test "pull refuses to rebase over a local merge commit" {
  "$BIN/ccd-onboard" --kit octo/demo
  git -C "$D" checkout -q -b side
  echo s > "$D/.claude/side"; git -C "$D" add .claude
  GIT_AUTHOR_EMAIL=ccdash@localhost git -C "$D" commit -qm side
  git -C "$D" checkout -q main
  git -C "$D" merge -q --no-ff side -m "local merge"
  push_commit two
  before=$(state)
  run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 3 ]
  [[ $output == *"local commits not from ccdash"* ]]
  [ "$(state)" = "$before" ]
}

@test "settings.local.json is never exempt" {
  export CCDASH_KIT=
  "$BIN/ccd-onboard" --kit octo/demo
  add_settings agent-kit.json '{"kit_version":"1"}'
  add_settings settings.local.json "$KITSET"
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
}

# ---- the real kit (skipped on the CI runner: no /opt/agent-kit, no claude) -------------------------------------
@test "real kit: ensure on a folder that is not a git root fails with exit 2 and the JSON failure line" {
  [ -x /opt/agent-kit/agent-kit.sh ] || skip "no /opt/agent-kit"
  command -v claude > /dev/null || skip "no claude"
  mkdir "$BATS_TEST_TMPDIR/nogit"
  run /opt/agent-kit/agent-kit.sh ensure "$BATS_TEST_TMPDIR/nogit" --json
  [ "$status" -eq 2 ]
  [ "$(printf '%s\n' "$output" | tail -n 1 | jq -r '[.ok, .code] | join(",")')" = "false,2" ]
}
