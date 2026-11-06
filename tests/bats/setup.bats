#!/usr/bin/env bats
# setup.sh against fakes and a temp root (CCDASH_SETUP_ROOT): nothing here touches the host's packages, users or sudoers.
# The fakes (tests/fixtures/setup-fake) record every call in $FAKE_STATE/calls.log.

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  T=$BATS_TEST_TMPDIR
  export FAKE_STATE=$T/state FAKE_ROOT=$T/root FAKE_INVOKER=tester
  FAKEBIN=$T/fakebin
  mkdir -p "$FAKEBIN" "$FAKE_STATE" "$FAKE_ROOT/etc" "$FAKE_ROOT/home/tester" "$FAKE_ROOT/var/log"
  for c in apt-get dpkg uname ss visudo usermod getent useradd loginctl systemctl sudo dockerd-rootless-setuptool.sh \
    curl docker claude-login cloudflared; do ln -s "$ROOT/tests/fixtures/setup-fake" "$FAKEBIN/$c"; done
  printf 'ID=debian\nVERSION_ID=13\nVERSION_CODENAME=trixie\n' >"$FAKE_ROOT/etc/os-release"
  export HOME=$T/hosthome
  mkdir -p "$HOME"
  export CCDASH_SETUP_ROOT=$FAKE_ROOT CCDASH_SETUP_BIN=$FAKEBIN CCDASH_SETUP_USER=tester CCDASH_SETUP_ALLOW_NONROOT=1
  export CCDASH_SETUP_DOCKER=$FAKEBIN/docker CCDASH_SETUP_CLAUDE_LOGIN=$FAKEBIN/claude-login
  export CCDASH_SETUP_CCD=$FAKEBIN/ccd CCDASH_SETUP_MIN_DISK_MB=1 CCDASH_SETUP_CF_LOGIN_TIMEOUT=20
  export CCDASH_SETUP_HEALTH_WAIT=3 CCDASH_SETUP_WAIT=3
  printf '#!/bin/sh\necho "ccd $*" >>"$FAKE_STATE/calls.log"\n' >"$FAKEBIN/ccd"
  chmod +x "$FAKEBIN/ccd"
  unset CLOUDFLARE_API_TOKEN SUDO_USER
}

calls() { cat "$FAKE_STATE/calls.log"; }
snapshot() { (cd "$FAKE_ROOT" && find . -type f ! -name '*.log' -exec sha256sum {} + | sort; find . -printf '%p %m\n' | sort); }
run_setup() { run timeout 120 "$ROOT/setup.sh" "$@" </dev/null; }

@test "with a fake cloudflared, setup runs the tunnel create, route and service commands" {
  run_setup --hostname ccdash.example.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qx 'cloudflared tunnel login' <(calls)
  grep -qx 'cloudflared tunnel create ccdash' <(calls)
  grep -qx 'cloudflared tunnel route dns ccdash ccdash.example.com' <(calls)
  grep -qx 'systemctl enable --now cloudflared-ccdash.service' <(calls)
  conf=$FAKE_ROOT/etc/cloudflared/config.yml
  grep -q 'hostname: ccdash.example.com' "$conf"
  grep -q 'service: http://127.0.0.1:7690' "$conf"
  grep -q '^tunnel: uuid-1$' "$conf"
  grep -q '^User=cloudflared$' "$FAKE_ROOT/etc/systemd/system/cloudflared-ccdash.service"
  grep -qx 'CCDASH_ORIGIN=https://ccdash.example.com' "$FAKE_ROOT/home/ccdash/ccdash/.env"
  grep -qF 'pkg.cloudflare.com/cloudflared any main' "$FAKE_ROOT/etc/apt/sources.list.d/cloudflared.list"
}

@test "a bare --hostname label is placed under the first Cloudflare domain" {
  run_setup --hostname dash
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qx 'cloudflared tunnel route dns ccdash dash.example.com' <(calls)
}

@test "login: 24 random characters, 0600 file owned by the invoker, set over stdin, never in the log or argv" {
  run_setup --no-cloudflare
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  f=$FAKE_ROOT/home/tester/ccdash-login.txt
  [ "$(stat -c %a "$f")" = 600 ]
  pw=$(sed -n 's/^Password: //p' "$f")
  [ "${#pw}" -eq 24 ]
  [ "$(cat "$FAKE_STATE/passwd-stdin")" = "$pw" ]
  grep -q -- '--stdin tester' "$FAKE_STATE/passwd-args"
  ! grep -qF "$pw" "$CCDASH_SETUP_ROOT/var/log/ccdash-setup.log"
  ! grep -qF "$pw" "$FAKE_STATE/calls.log"
  ! grep -qF "$pw" "$FAKE_STATE/passwd-args"
  [ "$(stat -c %a "$FAKE_ROOT/var/log/ccdash-setup.log")" = 600 ]
  ! calls | grep -q '^cloudflared'
}

@test "TOTP is required unless CLOUDFLARE_API_TOKEN is set; with a token an Access app with email OTP is created" {
  run_setup --no-cloudflare
  [ "$status" -eq 0 ]
  grep -qx 'CCDASH_TOTP_REQUIRED=1' "$FAKE_ROOT/home/ccdash/ccdash/.env"
  rm -rf "$FAKE_STATE" "$FAKE_ROOT/home"; mkdir -p "$FAKE_STATE" "$FAKE_ROOT/home/tester"
  CLOUDFLARE_ACCESS_EMAIL=me@example.com CLOUDFLARE_API_TOKEN=secret-token-value run_setup --hostname ccdash.example.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qx 'CCDASH_TOTP_REQUIRED=' "$FAKE_ROOT/home/ccdash/ccdash/.env"
  [ "$(jq -r .domain "$FAKE_STATE/access-app.json")" = ccdash.example.com ]
  [ "$(jq -r '.policies[0].decision' "$FAKE_STATE/access-app.json")" = allow ]
  ! grep -qF secret-token-value "$FAKE_ROOT/var/log/ccdash-setup.log"
  ! grep -qF secret-token-value "$FAKE_STATE/calls.log"
}

@test "a second run changes nothing" {
  run_setup --hostname ccdash.example.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  snapshot >"$T/before"
  : >"$FAKE_STATE/calls.log"
  run_setup --hostname ccdash.example.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  snapshot >"$T/after"
  diff "$T/before" "$T/after"
  ! calls | grep -E '^(apt-get install|useradd|usermod|loginctl|cloudflared tunnel (login|create|route)|systemctl (enable|restart|daemon-reload)|docker .*(pull|passwd))'
  ! calls | grep -E 'ccdash-passwd'
}

@test "nothing prompts: stdin closed, only the sign-in waits are faked" {
  run timeout 120 "$ROOT/setup.sh" --hostname ccdash.example.com <&-
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ -e "$FAKE_STATE/claude-login" ]
  grep -q '^cloudflared tunnel login' <(calls)
}

@test "the Claude sign-in can be skipped by a hook" {
  CCDASH_SETUP_SKIP_CLAUDE_LOGIN=1 run_setup --no-cloudflare
  [ "$status" -eq 0 ]
  [ ! -e "$FAKE_STATE/claude-login" ]
}

@test "git identity and the live self-test are delegated to ccd; --no-selftest skips the second" {
  run_setup --no-cloudflare
  [ "$status" -eq 0 ]
  grep -qx 'ccd identity --from-host' <(calls)
  grep -qx 'ccd doctor --live' <(calls)
  run_setup --no-cloudflare --no-selftest
  [ "$(grep -c '^ccd doctor' "$FAKE_STATE/calls.log")" -eq 1 ]
}

@test "--uninstall keeps volumes, then setup again works; --purge removes the volumes and the login file" {
  run_setup --no-cloudflare
  [ "$status" -eq 0 ]
  pw=$(sed -n 's/^Password: //p' "$FAKE_ROOT/home/tester/ccdash-login.txt")
  run_setup --uninstall
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -q '^docker compose .* down --remove-orphans$' <(calls)
  ! grep -q ' down .*-v' <(calls)
  [ ! -e "$FAKE_ROOT/etc/sudoers.d/ccdash" ]
  [ ! -e "$FAKE_ROOT/usr/local/bin/ccd" ]
  [ -f "$FAKE_ROOT/home/tester/ccdash-login.txt" ]
  run_setup --no-cloudflare
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ -x "$FAKE_ROOT/usr/local/bin/ccd" ]
  [ "$(sed -n 's/^Password: //p' "$FAKE_ROOT/home/tester/ccdash-login.txt")" = "$pw" ]
  run_setup --uninstall --purge
  [ "$status" -eq 0 ]
  grep -q ' down -v ' <(calls)
  [ ! -e "$FAKE_ROOT/home/tester/ccdash-login.txt" ]
}

@test "a failing step says what failed and prints the exact rerun command" {
  FAKE_FAIL=apt-get run_setup --no-cloudflare --no-selftest
  [ "$status" -eq 1 ]
  [[ $output == *"setup FAILED at step: 2/12 Packages"* ]]
  [[ $output == *"sudo $ROOT/setup.sh --no-cloudflare --no-selftest"* ]]
}

@test "preflight refuses an unsupported system and bad flags" {
  printf 'ID=ubuntu\nVERSION_ID=24.04\n' >"$FAKE_ROOT/etc/os-release"
  run_setup --no-cloudflare
  [ "$status" -eq 1 ]
  [[ $output == *"needs Debian 12 or 13"* ]]
  run_setup --bogus
  [ "$status" -eq 2 ]
  run_setup --hostname 'a b'
  [ "$status" -eq 2 ]
}

@test "shellcheck passes on setup.sh and the fakes" {
  command -v shellcheck >/dev/null || skip "shellcheck is not installed (CI runs it)"
  run shellcheck "$ROOT/setup.sh" "$ROOT/tests/fixtures/setup-fake"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
}
