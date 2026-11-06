#!/usr/bin/env bats
# ccd doctor --live against the fake claude. The container is replaced by a docker stub that runs
# `exec ... ccd-doctor` locally; `logs`, `info`, `inspect` and `run` answer from STUB_* variables.
# A short tmp dir is used for the tmux socket (sun_path is 107 bytes).

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  TD=$(mktemp -d /tmp/ccdt.XXXXXX)
  export HOME=$TD/home
  export CCDASH_WS=$TD/ws
  export CCDASH_TMUX=$TD/t.sock
  export FAKE_CLAUDE_HOME=$TD/fake
  export FAKE_CLAUDE_FIXTURES=$ROOT/tests/fixtures/2.1.317
  export CCDASH_FIXTURES=$ROOT/tests/fixtures/2.1.317
  export CCDASH_DOCTOR_WAIT=5 CCDASH_DOCTOR_ESC_WAIT=5 CCDASH_DOCTOR_HOOK_TIMEOUT=2 CCDASH_DOCTOR_SETTLE=1
  export CCDASH_SELFTEST_FILE=$TD/selftest.json
  export CCDASH_DOCKER=$TD/docker CCDASH_EGRESS_ALLOW=$TD/allow
  mkdir -p "$HOME/bin" "$HOME/.ccdash" "$CCDASH_WS/demo"
  ln -s "$ROOT/tests/fake-claude/claude" "$HOME/bin/claude"
  printf 'export PATH=%s/bin:$PATH\n' "$HOME" >"$HOME/.bash_profile"
  export PATH=$HOME/bin:$ROOT/rootfs/usr/local/bin:$PATH
  unset TMUX TMUX_PANE
  cat >"$TD/docker" <<'STUB'
#!/bin/bash
case $1 in
  exec) shift; while [ "$1" = -i ] || [ "$1" = -u ]; do [ "$1" = -u ] && shift; shift; done; shift; exec "$@" ;;
  inspect) if [ "$*" = "-f {{.Config.Image}} ccdash" ]; then echo img; exit 0; fi; [ "${STUB_EGRESS:-}" = 1 ] ;;
  logs) cat "${STUB_LOG:-/dev/null}" ;;
  info) echo "${STUB_RUNTIMES:-runc}" ;;
  run) case " $* " in *--runtime=runsc*) [ "${STUB_RUNSC_OK:-1}" = 1 ] ;; esac ;;
  *) exit 1 ;;
esac
STUB
  printf '#!/bin/bash\necho "$@" >>%s/allowed\n' "$TD" >"$TD/allow"
  chmod +x "$TD/docker" "$TD/allow"
}

teardown() { tmux -S "$CCDASH_TMUX" kill-server 2>/dev/null || true; rm -rf "$TD"; }

NAMES="hook_payloads posttooluse_shape esc_idle_prompt resume_keeps_id permission_fallthrough permission_allow permission_deny permission_timeout sessionstart_compact rate_limits egress_hosts gvisor memory_tool_names memory_subagent_noprompt"

st() { jq -r --arg c "$1" '.checks[] | select(.check == $c) | .status' "$CCDASH_SELFTEST_FILE"; }

@test "reports every check, all clean against matching fixtures, and deletes the scratch project" {
  run "$ROOT/bin/ccd" doctor --live
  [ "$status" -eq 0 ]
  for n in $NAMES; do [ -n "$(st "$n")" ] || { echo "missing check $n"; false; }; done
  for n in $NAMES; do [[ $output == *"$n"* ]] || { echo "not printed: $n"; false; }; done
  [ "$(st hook_payloads)" = pass ]
  [ "$(st esc_idle_prompt)" = pass ]
  [ "$(st permission_fallthrough)" = pass ]
  [ "$(st memory_subagent_noprompt)" = pass ]
  [ "$(st egress_hosts)" = skip ]
  [ "$(st gvisor)" = skip ]
  [ "$(jq .ok "$CCDASH_SELFTEST_FILE")" = true ]
  [ ! -e "$CCDASH_WS/_selftest" ]
  [ -s "$HOME/.ccdash/selftest.json" ]
  ! tmux -S "$CCDASH_TMUX" has-session -t =claude-_selftest 2>/dev/null
}

@test "a mismatched fixture is a warning and a selftest.json entry, not a failure" {
  cp -r "$ROOT/tests/fixtures/2.1.317" "$TD/fx"
  jq '. + {surprise: 1} | del(.permission_mode)' "$TD/fx/PermissionRequest.json" >"$TD/p" && mv "$TD/p" "$TD/fx/PermissionRequest.json"
  export CCDASH_FIXTURES=$TD/fx
  run "$ROOT/bin/ccd" doctor --live
  [ "$status" -eq 0 ]
  [ "$(st hook_payloads)" = warn ]
  [ "$(jq -r '.mismatches[0].check' "$CCDASH_SELFTEST_FILE")" = hook_payloads ]
  [[ $(jq -r '.mismatches[0].detail' "$CCDASH_SELFTEST_FILE") == *PermissionRequest*surprise* ]]
  [ "$(jq .ok "$CCDASH_SELFTEST_FILE")" = false ]
  [[ $output == *"WARN  hook_payloads"* ]]
  [ "$(jq -r '.mismatches | length' "$HOME/.ccdash/selftest.json")" = 1 ]
}

@test "no rate_limits on the plan: warning and the /usage fallback flag" {
  FAKE_CLAUDE_RATE_LIMITS=none run "$ROOT/bin/ccd" doctor --live
  [ "$status" -eq 0 ]
  [ "$(st rate_limits)" = warn ]
  [ -e "$HOME/.ccdash/usage-fallback.enabled" ]
}

@test "egress: only expected hosts are allowed; others are warnings; a clean log passes" {
  export STUB_EGRESS=1 STUB_LOG=$TD/log
  printf 'ALLOW api.anthropic.com:443\nDENY statsig.com:443\nDENY odd.example.com:8080\nDENY *.evil.com:443\nDENY github.com:80\n' >"$TD/log"
  run "$ROOT/bin/ccd" doctor --live
  [ "$status" -eq 0 ]
  [ "$(st egress_hosts)" = warn ]
  [ "$(cat "$TD/allowed")" = "github.com statsig.com" ]
  d=$(jq -r '.checks[] | select(.check == "egress_hosts") | .detail' "$CCDASH_SELFTEST_FILE")
  [[ $d == *"wanted): *.evil.com odd.example.com:8080;"* ]] || { echo "$d"; false; }
  printf 'ALLOW api.anthropic.com:443\n' >"$TD/log"
  rm "$TD/allowed"
  run "$ROOT/bin/ccd" doctor --live
  [ "$(st egress_hosts)" = pass ]
  [ ! -e "$TD/allowed" ]
}

@test "malformed ccd-doctor output is discarded with a warning and the exit status stays 0" {
  cat >"$TD/docker2" <<'STUB'
#!/bin/bash
case $1 in
  exec) case " $* " in *" ccd-doctor "*) printf '{"check":"a","status":"pass","detail":"ok"}\n{broken\n{"x":\n' ;; *) cat >/dev/null ;; esac ;;
  *) exit 1 ;;
esac
STUB
  chmod +x "$TD/docker2"
  CCDASH_DOCKER=$TD/docker2 run "$ROOT/bin/ccd" doctor --live
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ "$(st a)" = pass ]
  [[ $(jq -r '.checks[] | select(.check == "doctor_output") | .detail' "$CCDASH_SELFTEST_FILE") == "2 malformed"* ]]
}

@test "gVisor: enabled only when runsc runs; a failing runsc stays on runc with a warning" {
  export STUB_RUNTIMES='runc runsc' CCDASH_ENV_FILE=$TD/env
  printf 'A=1\nCCDASH_RUNTIME=\n' >"$TD/env"
  STUB_RUNSC_OK=0 run "$ROOT/bin/ccd" doctor --live
  [ "$(st gvisor)" = warn ]
  ! grep -q runsc "$TD/env"
  run "$ROOT/bin/ccd" doctor --live
  [ "$status" -eq 0 ]
  [ "$(st gvisor)" = pass ]
  grep -qx CCDASH_RUNTIME=runsc "$TD/env"
  grep -qx A=1 "$TD/env"
  # the .env is rewritten in place: owner and mode survive (a tmp+mv would reset them)
  chmod 640 "$TD/env"; ino=$(stat -c %i "$TD/env")
  run "$ROOT/bin/ccd" doctor --live
  [ "$(stat -c '%a %i' "$TD/env")" = "640 $ino" ]
  [ "$(jq -r '.gvisor | has("slowdown")' "$CCDASH_SELFTEST_FILE")" = true ]
}

@test "doctor without --live is a usage error" {
  run "$ROOT/bin/ccd" doctor
  [ "$status" -eq 2 ]
}
