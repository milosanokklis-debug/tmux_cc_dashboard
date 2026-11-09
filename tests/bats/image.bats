#!/usr/bin/env bats
# Image build inputs for the agent kit's MCP servers: pins agree everywhere, the egress allowlist, and the npx / chrome wrappers.
bats_require_minimum_version 1.5.0

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
}

pin() { sed -n "s/^$2=//p" "$1" | head -1; }

@test "AC-1.1 KIT_REF is 18ad921e (kit 0.14.0) and the same in Dockerfile, .env.example and compose.build.yaml" {
  e=$(pin "$ROOT/.env.example" KIT_REF)
  [ "$e" = 18ad921ec9d8b74e295350f876bf5cf1e7f15636 ]
  [[ $e =~ ^[0-9a-f]{40}$ ]]
  [ "$(sed -n 's/^ARG KIT_REF=//p' "$ROOT/Dockerfile")" = "$e" ]
  grep -q "KIT_REF: \${KIT_REF:-$e}" "$ROOT/compose.build.yaml"
}

@test "AC-1.2 image has gitleaks pinned: GITLEAKS_VERSION ARG and a sha256 check of the download" {
  v=$(sed -n 's/^ARG GITLEAKS_VERSION=//p' "$ROOT/Dockerfile")
  [[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
  grep -qi 'gitleaks.*sha256sum\|sha256sum.*gitleaks\|GITLEAKS_SHA256' "$ROOT/Dockerfile"
}

@test "SEMGREP_VERSION is the same in Dockerfile, .env.example and compose.build.yaml, and setup.sh copies it" {
  e=$(pin "$ROOT/.env.example" SEMGREP_VERSION)
  [[ $e =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
  [ "$(sed -n 's/^ARG SEMGREP_VERSION=//p' "$ROOT/Dockerfile")" = "$e" ]
  grep -q "SEMGREP_VERSION: \${SEMGREP_VERSION:-$e}" "$ROOT/compose.build.yaml"
  grep -q 'for k in .* SEMGREP_VERSION ' "$ROOT/setup.sh"
}

@test "egress allowlist has mcp.motion.dev, exactly once" {
  [ "$(grep -cx 'mcp.motion.dev' "$ROOT/egress/allowlist.txt")" -eq 1 ]
}

@test "chrome stand-in runs chromium with --no-sandbox and forwards its arguments" {
  d=$BATS_TEST_TMPDIR
  printf '#!/bin/sh\necho "args=$*"\n' >"$d/chromium"; chmod +x "$d/chromium"
  CCDASH_CHROMIUM=$d/chromium run "$ROOT/rootfs/opt/google/chrome/chrome" --headless "--user-data-dir=/x y"
  [ "$status" -eq 0 ]
  [ "$output" = "args=--no-sandbox --disable-dev-shm-usage --disable-gpu --headless --user-data-dir=/x y" ]
}

fake_npx() { # $1 = dir: wrapper copy that execs a fake npx, plus a small seed
  d=$1
  mkdir -p "$d/seed/_cacache" "$d/seed/_npx/aaa" "$d/bin"
  echo x >"$d/seed/_cacache/f"
  sed -e "s|exec /usr/bin/npx|exec $d/bin/fake-npx|" "$ROOT/rootfs/usr/local/bin/npx" >"$d/bin/npx"
  printf '#!/bin/sh\necho "cache=$npm_config_cache offline=$npm_config_prefer_offline args=$*"\n' >"$d/bin/fake-npx"
  chmod +x "$d/bin/npx" "$d/bin/fake-npx"
  export HOME=$d/home CCDASH_NPM_SEED=$d/seed; mkdir -p "$HOME"
}

@test "npx wrapper seeds a writable cache once, runs npx with it, and reseeds when the seed changes" {
  fake_npx "$BATS_TEST_TMPDIR"
  run "$BATS_TEST_TMPDIR/bin/npx" -y foo@1
  [ "$status" -eq 0 ]
  [ "$output" = "cache=$HOME/.cache/ccdash-npm offline=true args=-y foo@1" ]
  [ -f "$HOME/.cache/ccdash-npm/_cacache/f" ]
  echo y >"$HOME/.cache/ccdash-npm/marker"
  run "$BATS_TEST_TMPDIR/bin/npx" bar
  [ -f "$HOME/.cache/ccdash-npm/marker" ] # same seed: no reseed
  mkdir "$CCDASH_NPM_SEED/_npx/bbb"
  run "$BATS_TEST_TMPDIR/bin/npx" bar
  [ ! -e "$HOME/.cache/ccdash-npm/marker" ] # new seed: reseeded
  [ -d "$HOME/.cache/ccdash-npm/_npx/bbb" ]
}

@test "three npx wrappers started together leave one complete cache and all succeed" {
  fake_npx "$BATS_TEST_TMPDIR"
  for i in 1 2 3; do "$BATS_TEST_TMPDIR/bin/npx" "p$i" >"$BATS_TEST_TMPDIR/out$i" 2>&1 & done
  wait
  for i in 1 2 3; do grep -q "cache=$HOME/.cache/ccdash-npm offline=true args=p$i" "$BATS_TEST_TMPDIR/out$i"; done
  [ -f "$HOME/.cache/ccdash-npm/_cacache/f" ]
  [ -s "$HOME/.cache/ccdash-npm/.seed-stamp" ]
  [ "$(ls -A "$HOME/.cache" | wc -l)" -eq 1 ] # no temp dirs or lock left
}
