#!/usr/bin/env bash
# setup.sh: creates the whole ccdash system on a Debian 12/13 host. Run: sudo ./setup.sh [flags]
#   --no-cloudflare     skip the Cloudflare tunnel (SSH tunnel only)
#   --hostname <name>   public hostname (a full name with a dot, or a label under your first Cloudflare domain)
#   --no-selftest       skip `ccd doctor --live`
#   --uninstall         remove the stack, keep the volumes;  --uninstall --purge also deletes volumes and secrets
# Asks no questions except the two sign-in waits (Claude, Cloudflare). Every step is idempotent.
# Log: /var/log/ccdash-setup.log. A failed step prints what failed and the exact command to run again.
#
# Test and automation hooks (every external action goes through one of these, so bats can swap in fakes):
#   CCDASH_SETUP_ROOT              prefix for every host path (/etc, /var, /usr/local, /run); default empty
#   CCDASH_SETUP_BIN               directory put first in PATH (fake apt-get, curl, cloudflared, sudo, ...)
#   CCDASH_SETUP_LOG               log file (default $ROOT/var/log/ccdash-setup.log)
#   CCDASH_SETUP_DOCKER            docker command as the ccdash user (default: sudo -n -u ccdash /usr/local/bin/ccdash-docker)
#   CCDASH_SETUP_CLAUDE_LOGIN      command that signs Claude in (default: docker exec -it -u ccd ccdash claude auth login)
#   CCDASH_SETUP_SKIP_CLAUDE_LOGIN=1   skip the Claude sign-in
#   CCDASH_SETUP_CLOUDFLARED       cloudflared binary (default cloudflared)
#   CCDASH_SETUP_CCD               the ccd command used for identity and doctor (default $ROOT/usr/local/bin/ccd)
#   CCDASH_SETUP_USER              invoking account (default $SUDO_USER)
#   CCDASH_SETUP_ALLOW_NONROOT=1   do not require uid 0 (tests with a temp root)
#   CCDASH_SETUP_MIN_DISK_MB, CCDASH_SETUP_HEALTH_WAIT, CCDASH_SETUP_CF_LOGIN_TIMEOUT, CCDASH_SETUP_WAIT   limits in seconds / MB
#   CCDASH_SETUP_EGRESS=1          also layer compose.egress.yaml (builds the egress proxy image locally)
# Cloudflare Access: export CLOUDFLARE_API_TOKEN (and optionally CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ACCESS_EMAIL) and keep
# it through sudo with `sudo --preserve-env=CLOUDFLARE_API_TOKEN ./setup.sh`.
set -uo pipefail
umask 077

SELF=$(readlink -f "${BASH_SOURCE[0]}")
SRC=$(dirname "$SELF")
ARGS=("$@")
R=${CCDASH_SETUP_ROOT:-}
LOG=${CCDASH_SETUP_LOG:-$R/var/log/ccdash-setup.log}
[ -z "${CCDASH_SETUP_BIN:-}" ] || PATH=$CCDASH_SETUP_BIN:$PATH
export PATH DEBIAN_FRONTEND=noninteractive
PORT=7690
NO_CLOUDFLARE=0 HOSTNAME_ARG="" NO_SELFTEST=0 UNINSTALL=0 PURGE=0

# ---- output -------------------------------------------------------------------------------------------------
exec 3<&0 0</dev/null # fd 3 is the terminal; only the Claude sign-in reads it, so nothing else can block on input
if ! { mkdir -p "$(dirname "$LOG")" && : >>"$LOG"; }; then echo "setup: cannot write $LOG" >&2; exit 1; fi
chmod 600 "$LOG" 2>/dev/null || true
exec > >(tee -a "$LOG") 2>&1

say() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*"; WARNINGS+=("$*"); }
WARNINGS=()
CURRENT="start"
rerun_cmd() {
  local c="" a
  [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || c="--preserve-env=CLOUDFLARE_API_TOKEN "
  printf 'sudo %s%q' "$c" "$SELF"
  for a in "${ARGS[@]}"; do printf ' %q' "$a"; done
  printf '\n'
}
die() {
  say ""
  say "setup FAILED at step: $CURRENT"
  say "  $*"
  say "Log: $LOG"
  say "Fix the problem, then run the same command again (finished steps are skipped):"
  say "  $(rerun_cmd)"
  exit 1
}
TMP=$(mktemp -d) || die "cannot create a temp dir"
trap 'rm -rf "$TMP"' EXIT
step() { CURRENT="$1"; say ""; say "== $1"; }

# ---- arguments ----------------------------------------------------------------------------------------------
usage() { say "usage: sudo ./setup.sh [--no-cloudflare] [--hostname <name>] [--no-selftest] [--uninstall [--purge]]"; exit 2; }
while [ $# -gt 0 ]; do
  case $1 in
    --no-cloudflare) NO_CLOUDFLARE=1 ;;
    --no-selftest) NO_SELFTEST=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    --hostname) [ $# -ge 2 ] || usage; HOSTNAME_ARG=$2; shift ;;
    --hostname=*) HOSTNAME_ARG=${1#*=} ;;
    -h | --help) usage ;;
    *) say "setup: unknown option: $1"; usage ;;
  esac
  shift
done
[ "$PURGE" -eq 0 ] || [ "$UNINSTALL" -eq 1 ] || { say "setup: --purge only goes with --uninstall"; usage; }
if [ -n "$HOSTNAME_ARG" ] && ! [[ $HOSTNAME_ARG =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$ ]]; then
  say "setup: invalid --hostname"; exit 2
fi
[ "$NO_CLOUDFLARE" -eq 0 ] || [ -z "$HOSTNAME_ARG" ] || { say "setup: --hostname needs Cloudflare (drop --no-cloudflare)"; exit 2; }

# ---- paths and helpers --------------------------------------------------------------------------------------
BIN_DIR=$R/usr/local/bin
LIB_DIR=$R/usr/local/lib/ccdash
SUDOERS=$R/etc/sudoers.d/ccdash
CF_HOME=$R/var/lib/cloudflared
CF_CONF=$R/etc/cloudflared/config.yml
CF_UNIT=$R/etc/systemd/system/cloudflared-ccdash.service
CCD=${CCDASH_SETUP_CCD:-$BIN_DIR/ccd}
CLOUDFLARED=${CCDASH_SETUP_CLOUDFLARED:-cloudflared}
DOCKER_STR=${CCDASH_SETUP_DOCKER:-sudo -n -u ccdash /usr/local/bin/ccdash-docker}
read -r -a DOCKER <<<"$DOCKER_STR"
HEALTH_WAIT=${CCDASH_SETUP_HEALTH_WAIT:-180}
WAIT=${CCDASH_SETUP_WAIT:-60}
SELFTEST_JSON=$R/var/log/ccdash-selftest.json

is_root() { [ "$(id -u)" -eq 0 ]; }
chown_if_root() { is_root || return 0; chown "$@"; }
pw_field() { getent passwd "$1" 2>/dev/null | cut -d: -f"$2"; } # pw_field user N
have_user() { getent passwd "$1" >/dev/null 2>&1; }
same_file() { [ -f "$2" ] && cmp -s "$1" "$2"; }
# put <src> <dst> <mode> [owner:group]: copy only when different; return 0 if it changed something
put() {
  same_file "$1" "$2" && [ "$(stat -c %a "$2")" = "$3" ] && return 1
  mkdir -p "$(dirname "$2")" || die "cannot create $(dirname "$2")"
  install -m "$3" "$1" "$2" || die "cannot write $2"
  [ -z "${4:-}" ] || chown_if_root "$4" "$2"
  say "wrote $2"
  return 0
}
# set_env <file> KEY VALUE: replace or append KEY=VALUE (file keeps its mode and owner)
set_env() {
  local f=$1 k=$2 v=$3 t
  if [ -f "$f" ] && grep -qxF -- "$k=$v" "$f"; then return 1; fi
  t=$(mktemp "$TMP/env.XXXXXX") || die "mktemp failed"
  if [ -f "$f" ]; then grep -v -- "^$k=" "$f" >"$t" || true; fi
  printf '%s=%s\n' "$k" "$v" >>"$t"
  cat "$t" >"$f" || die "cannot write $f"
  return 0
}
get_env() { grep -m1 -- "^$2=" "$1" 2>/dev/null | cut -d= -f2-; }
wait_for() { # wait_for <seconds> <description> <command...>
  local n=$1 what=$2 i=0
  shift 2
  while ! "$@" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -le "$n" ] || return 1
    sleep 1
  done
  say "$what: ready"
}
apt_install() { apt-get install -y --no-install-recommends -o Dpkg::Options::=--force-confold "$@" || die "apt-get install $* failed"; }
pkg_installed() { dpkg -s "$1" 2>/dev/null | grep -q '^Status: install ok installed'; }

INVOKER=${CCDASH_SETUP_USER:-${SUDO_USER:-}}
CCDASH_HOME=""
INSTALL_DIR=""
ccdash_paths() {
  CCDASH_HOME=$(pw_field ccdash 6)
  INSTALL_DIR=${CCDASH_HOME:+$CCDASH_HOME/ccdash}
}
compose_files() {
  COMPOSE_F=(-f "$INSTALL_DIR/compose.yaml")
  [ "${CCDASH_SETUP_EGRESS:-0}" != 1 ] || COMPOSE_F+=(-f "$INSTALL_DIR/compose.egress.yaml")
}
dcompose() { (cd "$INSTALL_DIR" && "${DOCKER[@]}" compose -p ccdash --env-file "$INSTALL_DIR/.env" "${COMPOSE_F[@]}" "$@"); }
dexec() { "${DOCKER[@]}" exec "$@"; }

# ---- uninstall ----------------------------------------------------------------------------------------------
uninstall() {
  step "Uninstall"
  ccdash_paths
  if [ -n "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/.env" ]; then
    compose_files
    if [ "$PURGE" -eq 1 ]; then
      dcompose down -v --remove-orphans || die "compose down -v failed"
    else
      dcompose down --remove-orphans || die "compose down failed"
    fi
  else
    say "no compose project found"
  fi
  if [ -f "$CF_UNIT" ]; then
    systemctl disable --now cloudflared-ccdash.service || warn "could not stop cloudflared-ccdash"
    rm -f "$CF_UNIT" "$CF_CONF"
    systemctl daemon-reload || true
    say "removed the tunnel service (the tunnel and DNS record stay in Cloudflare)"
  fi
  rm -f "$SUDOERS" "$BIN_DIR/ccd" "$BIN_DIR/ccdash-docker" "$LIB_DIR/ccd"
  rmdir "$LIB_DIR" 2>/dev/null || true
  if [ "$PURGE" -eq 1 ]; then
    [ -z "$INSTALL_DIR" ] || rm -rf "${INSTALL_DIR:?}"
    local h
    h=$(pw_field "${INVOKER:-nobody}" 6)
    [ -z "$h" ] || rm -f "$h/ccdash-login.txt"
    say "purged volumes, install directory and the login file"
  else
    say "kept the volumes (ccdash-home, ccdash-workspace, ccdash-web, ccdash-git), $INSTALL_DIR and ~/ccdash-login.txt"
  fi
  say "Packages, the ccdash user and rootless Docker were left in place. Run sudo ./setup.sh to install again."
}

# ---- steps --------------------------------------------------------------------------------------------------
preflight() {
  step "1/12 Preflight"
  if ! is_root && [ "${CCDASH_SETUP_ALLOW_NONROOT:-0}" != 1 ]; then die "run with sudo: sudo ./setup.sh"; fi
  [ -n "$INVOKER" ] && [ "$INVOKER" != root ] || die "run it with sudo from your normal account (SUDO_USER is empty or root)"
  [[ $INVOKER =~ ^[a-z_][a-z0-9_-]*$ ]] || die "unsupported user name: $INVOKER"
  have_user "$INVOKER" || die "user $INVOKER does not exist"
  local id="" ver=""
  # shellcheck disable=SC1091
  # shellcheck disable=SC1091
  [ -r "$R/etc/os-release" ] && id=$(. "$R/etc/os-release" && echo "${ID:-}") && ver=$(. "$R/etc/os-release" && echo "${VERSION_ID:-}")
  { [ "$id" = debian ] && { [ "$ver" = 12 ] || [ "$ver" = 13 ]; }; } || die "needs Debian 12 or 13 (found ${id:-unknown} ${ver:-})"
  ARCH=$(uname -m)
  case $ARCH in x86_64 | aarch64) ;; *) die "needs x86_64 or arm64 (found $ARCH)" ;; esac
  local free min=${CCDASH_SETUP_MIN_DISK_MB:-5120}
  mkdir -p "$R/var/lib" 2>/dev/null || true
  free=$(df -Pm "$R/var/lib" | awk 'NR==2 {print $4}')
  [[ ${free:-0} =~ ^[0-9]+$ ]] && [ "$free" -ge "$min" ] || die "needs ${min} MB free under /var/lib (found ${free:-?})"
  if [ -n "$(ss -ltnH "sport = :$PORT" 2>/dev/null)" ]; then
    ccdash_paths
    if [ -n "$INSTALL_DIR" ] && [ -n "$("${DOCKER[@]}" ps -q --filter name=^ccdash\$ 2>/dev/null)" ]; then
      say "port $PORT is held by the ccdash stack (a re-run)"
    else
      die "port $PORT is already in use by something else"
    fi
  fi
  say "ok: Debian $ver $ARCH, user $INVOKER"
}

packages() {
  step "2/12 Packages"
  local codename arch need=() updated=0 p
  # shellcheck disable=SC1091
  codename=$(. "$R/etc/os-release" && echo "${VERSION_CODENAME:-}")
  [ -n "$codename" ] || die "no VERSION_CODENAME in os-release"
  if [ "$ARCH" = x86_64 ]; then arch=amd64; else arch=arm64; fi
  for p in ca-certificates curl jq git uidmap dbus-user-session slirp4netns; do pkg_installed "$p" || need+=("$p"); done
  if [ "${#need[@]}" -gt 0 ]; then
    apt-get update || die "apt-get update failed"
    updated=1
    apt_install "${need[@]}"
  fi
  # Docker Engine (Docker's apt repo)
  local keyring=$R/etc/apt/keyrings/docker.asc dlist=$R/etc/apt/sources.list.d/docker.list line
  if [ ! -s "$keyring" ]; then
    mkdir -p "$(dirname "$keyring")"
    curl -fsSL --max-time 60 -o "$TMP/docker.asc" https://download.docker.com/linux/debian/gpg || die "cannot download Docker's apt key"
    install -m 0644 "$TMP/docker.asc" "$keyring"
  fi
  line="deb [arch=$arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $codename stable"
  if [ ! -f "$dlist" ] || [ "$(cat "$dlist")" != "$line" ]; then
    mkdir -p "$(dirname "$dlist")"
    printf '%s\n' "$line" >"$TMP/docker.list" && install -m 0644 "$TMP/docker.list" "$dlist"
    updated=0
  fi
  need=()
  for p in docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-ce-rootless-extras; do pkg_installed "$p" || need+=("$p"); done
  if [ "$NO_CLOUDFLARE" -eq 0 ]; then
    local ckey=$R/usr/share/keyrings/cloudflare-main.gpg clist=$R/etc/apt/sources.list.d/cloudflared.list
    # "any main": the codename-specific line has no candidate on Debian 13 (NOTES.md, Phase A check 4)
    local cline="deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main"
    if [ ! -s "$ckey" ]; then
      mkdir -p "$(dirname "$ckey")"
      curl -fsSL --max-time 60 -o "$TMP/cf.gpg" https://pkg.cloudflare.com/cloudflare-main.gpg || die "cannot download Cloudflare's apt key"
      install -m 0644 "$TMP/cf.gpg" "$ckey"
    fi
    if [ ! -f "$clist" ] || [ "$(cat "$clist")" != "$cline" ]; then
      mkdir -p "$(dirname "$clist")"
      printf '%s\n' "$cline" >"$TMP/cf.list" && install -m 0644 "$TMP/cf.list" "$clist"
      updated=0
    fi
    pkg_installed cloudflared || need+=(cloudflared)
  fi
  if [ "${#need[@]}" -gt 0 ]; then
    [ "$updated" -eq 1 ] || apt-get update || die "apt-get update failed"
    apt_install "${need[@]}"
  else
    say "all packages present"
  fi
}

ccdash_user() {
  step "3/12 Host user ccdash, rootless Docker, ccd"
  local uid rt unit
  if ! have_user ccdash; then
    useradd --create-home --shell /bin/bash --user-group ccdash || die "useradd ccdash failed"
    say "created user ccdash (no password, no sudo)"
  fi
  ccdash_paths
  uid=$(pw_field ccdash 3)
  [ -n "$uid" ] && [ -n "$CCDASH_HOME" ] || die "cannot read the ccdash account"
  if ! grep -q '^ccdash:' "$R/etc/subuid" 2>/dev/null || ! grep -q '^ccdash:' "$R/etc/subgid" 2>/dev/null; then
    usermod --add-subuids 200000-265535 --add-subgids 200000-265535 ccdash || die "cannot add subordinate ids for ccdash"
  fi
  if [ ! -e "$R/var/lib/systemd/linger/ccdash" ]; then
    loginctl enable-linger ccdash || die "enable-linger failed"
  fi
  put "$SRC/host/ccdash-docker" "$BIN_DIR/ccdash-docker" 755 root:root || true
  # the invoking account may run exactly this wrapper as ccdash
  printf '%s ALL=(ccdash) NOPASSWD: /usr/local/bin/ccdash-docker\n' "$INVOKER" >"$TMP/sudoers" || die "mktemp write failed"
  if ! same_file "$TMP/sudoers" "$SUDOERS"; then
    visudo -cf "$TMP/sudoers" >/dev/null || die "the generated sudoers rule did not validate"
    mkdir -p "$(dirname "$SUDOERS")"
    install -m 0440 "$TMP/sudoers" "$SUDOERS" || die "cannot write $SUDOERS"
    chown_if_root root:root "$SUDOERS"
    say "wrote $SUDOERS"
  fi
  # ccd: the real script plus a wrapper that points it at ccdash-docker
  put "$SRC/bin/ccd" "$LIB_DIR/ccd" 755 root:root || true
  cat >"$TMP/ccd-wrapper" <<EOF
#!/bin/sh
# Installed by setup.sh. Runs ccd against the rootless Docker of the ccdash user.
CCDASH_DOCKER=\${CCDASH_DOCKER:-sudo -n -u ccdash /usr/local/bin/ccdash-docker}
export CCDASH_DOCKER
exec /usr/local/lib/ccdash/ccd "\$@"
EOF
  sed -i "s|exec /usr/local/lib/ccdash/ccd|exec $LIB_DIR/ccd|" "$TMP/ccd-wrapper"
  put "$TMP/ccd-wrapper" "$BIN_DIR/ccd" 755 root:root || true
  rt=$R/run/user/$uid
  [ -e "$rt/bus" ] || systemctl start "user@$uid.service" || warn "could not start user@$uid.service"
  wait_for "$WAIT" "ccdash user session" test -e "$rt/bus" || die "the ccdash user's systemd session did not start ($rt/bus)"
  if ! "${DOCKER[@]}" info >/dev/null 2>&1; then
    unit=$(command -v dockerd-rootless-setuptool.sh || echo /usr/bin/dockerd-rootless-setuptool.sh)
    sudo -n -u ccdash env "XDG_RUNTIME_DIR=/run/user/$uid" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus" \
      "HOME=$CCDASH_HOME" "PATH=/usr/bin:/usr/sbin:/bin:/sbin" "$unit" install || die "rootless Docker setup failed"
    wait_for "$WAIT" "rootless Docker" "${DOCKER[@]}" info || die "rootless Docker does not answer"
  else
    say "rootless Docker already running"
  fi
}

ORIGIN=""
TOTP_REQUIRED=1
[ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ "$NO_CLOUDFLARE" -eq 1 ] || TOTP_REQUIRED=0 # Access replaces TOTP only with a tunnel
write_env_and_start() {
  step "4/12 Configuration, image, stack"
  local f e files=(compose.yaml compose.egress.yaml compose.build.yaml)
  mkdir -p "$INSTALL_DIR" || die "cannot create $INSTALL_DIR"
  chown_if_root ccdash:ccdash "$INSTALL_DIR"
  chmod 750 "$INSTALL_DIR"
  for f in "${files[@]}"; do put "$SRC/$f" "$INSTALL_DIR/$f" 644 ccdash:ccdash || true; done
  if [ "${CCDASH_SETUP_EGRESS:-0}" = 1 ]; then
    mkdir -p "$INSTALL_DIR/egress"
    chown_if_root ccdash:ccdash "$INSTALL_DIR/egress"
    for f in Dockerfile proxy.js allowlist.txt; do put "$SRC/egress/$f" "$INSTALL_DIR/egress/$f" 644 ccdash:ccdash || true; done
  fi
  e=$INSTALL_DIR/.env
  if [ ! -f "$e" ]; then
    install -m 0600 "$SRC/.env.example" "$e" || die "cannot create $e"
    say "created $e"
  fi
  chown_if_root ccdash:ccdash "$e"
  chmod 600 "$e"
  local k v
  for k in CCDASH_VERSION CLAUDE_CODE_VERSION S6_OVERLAY_VERSION BASIC_MEMORY_VERSION KIT_REPO KIT_REF; do
    v=$(get_env "$SRC/.env.example" "$k")
    if [ -n "$v" ]; then set_env "$e" "$k" "$v" || true; fi
  done
  start_stack
}

# (re)apply the settings that can change during a run, pull if needed, compose up (a no-op when nothing changed)
start_stack() {
  local e=$INSTALL_DIR/.env image
  if [ -n "$ORIGIN" ]; then set_env "$e" CCDASH_ORIGIN "$ORIGIN" || true; fi
  if [ "$TOTP_REQUIRED" -eq 1 ]; then totp_val=1; else totp_val=""; fi
  set_env "$e" CCDASH_TOTP_REQUIRED "$totp_val" || true
  compose_files
  image="ghcr.io/milosanokklis-debug/ccdash:$(get_env "$e" CCDASH_VERSION)"
  if ! "${DOCKER[@]}" image inspect "$image" >/dev/null 2>&1; then
    say "pulling $image"
    dcompose pull ccdash || die "cannot pull $image from GHCR"
  fi
  dcompose up -d || die "docker compose up failed"
  wait_for "$HEALTH_WAIT" "dashboard /healthz" curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" \
    || die "the dashboard did not answer http://127.0.0.1:$PORT/healthz in ${HEALTH_WAIT}s (see: sudo -u ccdash /usr/local/bin/ccdash-docker logs ccdash)"
}

LOGIN_FILE=""
login() {
  step "5/12 Dashboard login"
  local home pw t
  home=$(pw_field "$INVOKER" 6)
  [ -n "$home" ] || die "no home directory for $INVOKER"
  LOGIN_FILE=$home/ccdash-login.txt
  if [ -f "$LOGIN_FILE" ]; then
    say "$LOGIN_FILE exists; keeping the current login"
    return 0
  fi
  pw=$(set +o pipefail; LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
  [ "${#pw}" -eq 24 ] || die "could not generate a password"
  t=$(mktemp "$home/.ccdash-login.XXXXXX") || die "cannot create a file in $home"
  chmod 600 "$t"
  chown_if_root "$INVOKER:" "$t"
  printf 'ccdash dashboard login\nUsername: %s\nPassword: %s\n' "$INVOKER" "$pw" >"$t"
  if ! printf '%s\n' "$pw" | dexec -i -u web ccdash node /opt/ccdash/dashboard/ccdash-passwd.js --stdin "$INVOKER" >/dev/null; then
    rm -f "$t"
    die "could not set the dashboard password"
  fi
  mv -f "$t" "$LOGIN_FILE" || die "cannot write $LOGIN_FILE"
  pw=""
  say "login written to $LOGIN_FILE (mode 600, owner $INVOKER); the password is not in this log"
}

identity() {
  step "6/12 Git identity"
  if [ -n "$(dexec -u ccd ccdash git config --global user.email 2>/dev/null)" ]; then
    say "git identity already set"
    return 0
  fi
  local home
  home=$(pw_field "$INVOKER" 6)
  if HOME=$home GIT_CONFIG_NOSYSTEM=1 CCDASH_DOCKER="$DOCKER_STR" "$CCD" identity --from-host; then
    return 0
  fi
  CCDASH_DOCKER="$DOCKER_STR" "$CCD" identity "$INVOKER" "$INVOKER@localhost" || warn "could not set the git identity (ccd identity <name> <email>)"
}

claude_login() {
  step "7/12 Claude sign-in"
  if [ "${CCDASH_SETUP_SKIP_CLAUDE_LOGIN:-0}" = 1 ]; then
    say "skipped (CCDASH_SETUP_SKIP_CLAUDE_LOGIN=1)"
    return 0
  fi
  if dexec -u ccd ccdash claude auth status >/dev/null 2>&1; then
    say "Claude is already signed in"
    return 0
  fi
  say "Open the URL that Claude prints in a browser, approve, then paste the code here."
  if [ -n "${CCDASH_SETUP_CLAUDE_LOGIN:-}" ]; then
    # shellcheck disable=SC2086 # a hook command line, split on purpose
    $CCDASH_SETUP_CLAUDE_LOGIN <&3
  elif [ -t 3 ]; then
    dexec -it -u ccd ccdash claude auth login <&3
  else
    warn "Claude sign-in needs a terminal. Run: ccd login (then /login)"
    return 0
  fi || warn "Claude sign-in did not finish. Run it later with: ccd login"
}

# --- Cloudflare ---
cf_as() { sudo -n -u cloudflared env "HOME=$CF_HOME" "$CLOUDFLARED" "$@"; }
cf_api() { # cf_api METHOD PATH [body-file]
  local hdr=$TMP/cf-header
  printf 'Authorization: Bearer %s\n' "${CF_TOKEN:-$CLOUDFLARE_API_TOKEN}" >"$hdr"
  local data=()
  [ -z "${3:-}" ] || data=(--data "@$3")
  curl -fsS --max-time 30 -X "$1" -H "@$hdr" -H 'Content-Type: application/json' "${data[@]}" "https://api.cloudflare.com/client/v4$2"
}
cf_login() {
  local cert=$CF_HOME/.cloudflared/cert.pem out=$TMP/cflogin.out timeout=${CCDASH_SETUP_CF_LOGIN_TIMEOUT:-600} pid i=0 shown=0 url
  [ ! -s "$cert" ] || { say "cloudflared is already logged in"; return 0; }
  say "Open the URL below in a browser and pick the domain for ccdash."
  : >"$out"
  cf_as tunnel login >"$out" 2>&1 </dev/null & # prints a URL and never exits by itself
  pid=$!
  while [ ! -s "$cert" ]; do
    if [ "$shown" -eq 0 ] && url=$(grep -m1 -o 'https://[^ ]*' "$out") && [ -n "$url" ]; then
      say "$url"
      shown=1
    fi
    i=$((i + 1))
    if [ "$i" -gt "$timeout" ]; then
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      die "no cloudflared login within ${timeout}s (cert.pem never appeared)"
    fi
    sleep 1
  done
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  say "cloudflared login done"
}

cf_zone_name() { # prints the domain of the cert's zone
  local cert=$CF_HOME/.cloudflared/cert.pem body zone token name
  body=$(sed -e '/-----/d' "$cert" | tr -d '\n' | base64 -d 2>/dev/null)
  zone=$(jq -r '.zoneID // empty' <<<"$body" 2>/dev/null)
  token=$(jq -r '.apiToken // empty' <<<"$body" 2>/dev/null)
  [ -n "$zone" ] && [ -n "$token" ] || return 1
  name=$(CF_TOKEN=$token cf_api GET "/zones/$zone" | jq -r '.result.name // empty') || return 1
  [ -n "$name" ] && printf '%s\n' "$name"
}

TUNNEL_ID=""
CF_HOST=""
cloudflare_tunnel() {
  step "8/12 Cloudflare tunnel"
  have_user cloudflared || useradd --system --home-dir /var/lib/cloudflared --create-home --shell /usr/sbin/nologin cloudflared \
    || die "cannot create the cloudflared system user"
  mkdir -p "$CF_HOME" "$(dirname "$CF_CONF")"
  chown_if_root cloudflared: "$CF_HOME"
  chmod 750 "$CF_HOME"
  cf_login
  if [ -n "$HOSTNAME_ARG" ] && [[ $HOSTNAME_ARG == *.* ]]; then
    CF_HOST=$HOSTNAME_ARG
  else
    local zone
    zone=$(cf_zone_name) || die "cannot find your Cloudflare domain from the login. Run again with --hostname <full.name>"
    CF_HOST=${HOSTNAME_ARG:-ccdash}.$zone
  fi
  say "public hostname: $CF_HOST"
  local list
  list=$(cf_as tunnel list --output json 2>/dev/null) || die "cloudflared tunnel list failed"
  TUNNEL_ID=$(jq -r '[.[]? | select(.name == "ccdash" and (.deleted_at == null or .deleted_at == "0001-01-01T00:00:00Z"))][0].id // empty' <<<"$list")
  if [ -z "$TUNNEL_ID" ]; then
    cf_as tunnel create ccdash || die "cloudflared tunnel create ccdash failed"
    list=$(cf_as tunnel list --output json 2>/dev/null) || die "cloudflared tunnel list failed"
    TUNNEL_ID=$(jq -r '[.[]? | select(.name == "ccdash")][0].id // empty' <<<"$list")
  fi
  [ -n "$TUNNEL_ID" ] || die "cannot find the id of tunnel ccdash"
  [ -s "$CF_HOME/.cloudflared/$TUNNEL_ID.json" ] \
    || die "tunnel ccdash exists but its credentials file is missing. Delete it (cloudflared tunnel delete ccdash) and run again"
  cat >"$TMP/cf.yml" <<EOF
tunnel: $TUNNEL_ID
credentials-file: /var/lib/cloudflared/.cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: $CF_HOST
    service: http://127.0.0.1:$PORT
  - service: http_status:404
EOF
  CF_CHANGED=0
  if put "$TMP/cf.yml" "$CF_CONF" 640 root:cloudflared; then CF_CHANGED=1; fi
  cat >"$TMP/cf.service" <<EOF
[Unit]
Description=Cloudflare tunnel for ccdash
After=network-online.target
Wants=network-online.target

[Service]
User=cloudflared
ExecStart=/usr/bin/cloudflared --no-autoupdate --config /etc/cloudflared/config.yml tunnel run ccdash
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  if put "$TMP/cf.service" "$CF_UNIT" 644 root:root; then systemctl daemon-reload || die "systemctl daemon-reload failed"; CF_CHANGED=1; fi
}
CF_CHANGED=0

cloudflare_publish() { # DNS route and service start: after Access exists when a token is set
  if ! systemctl is-enabled --quiet cloudflared-ccdash.service 2>/dev/null || ! systemctl is-active --quiet cloudflared-ccdash.service 2>/dev/null; then
    cf_as tunnel route dns ccdash "$CF_HOST" || die "cloudflared tunnel route dns ccdash $CF_HOST failed"
    systemctl enable --now cloudflared-ccdash.service || die "cannot start cloudflared-ccdash.service"
  elif [ "$CF_CHANGED" -eq 1 ]; then
    cf_as tunnel route dns ccdash "$CF_HOST" || die "cloudflared tunnel route dns ccdash $CF_HOST failed"
    systemctl restart cloudflared-ccdash.service || die "cannot restart cloudflared-ccdash.service"
  fi
  ORIGIN=https://$CF_HOST
}

access_app() {
  step "9/12 Second factor"
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    say "TOTP is required at the first login (no CLOUDFLARE_API_TOKEN)"
    return 0
  fi
  if [ "$NO_CLOUDFLARE" -eq 1 ]; then
    say "no tunnel, so no Access app; TOTP is not required"
    return 0
  fi
  local acct email apps body
  acct=${CLOUDFLARE_ACCOUNT_ID:-}
  if [ -z "$acct" ]; then
    acct=$(cf_api GET /accounts | jq -r '.result[0].id // empty') || acct=""
  fi
  email=${CLOUDFLARE_ACCESS_EMAIL:-$(HOME=$(pw_field "$INVOKER" 6) git config --global user.email 2>/dev/null)}
  if [ -z "$acct" ] || [ -z "$email" ]; then
    warn "Cloudflare Access not created (need an account id and an email: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ACCESS_EMAIL); TOTP stays required"
    TOTP_REQUIRED=1
    return 1
  fi
  apps=$(cf_api GET "/accounts/$acct/access/apps") || apps=""
  if jq -e --arg d "$CF_HOST" '.result[]? | select(.domain == $d)' >/dev/null 2>&1 <<<"$apps"; then
    say "Access app for $CF_HOST already exists"
    TOTP_REQUIRED=0
    return 0
  fi
  body=$TMP/access-app.json
  jq -n --arg d "$CF_HOST" --arg e "$email" '{
    name: "ccdash", domain: $d, type: "self_hosted", session_duration: "1h", app_launcher_visible: false,
    policies: [{name: "ccdash email one-time code", decision: "allow", include: [{email: {email: $e}}]}]
  }' >"$body"
  if cf_api POST "/accounts/$acct/access/apps" "$body" >/dev/null; then
    say "created the Access app for $CF_HOST (email one-time code for $email)"
    TOTP_REQUIRED=0
  else
    warn "could not create the Cloudflare Access app; TOTP stays required"
    TOTP_REQUIRED=1
    return 1
  fi
}

memory() {
  step "10/12 Basic Memory"
  dexec -u ccd ccdash ccd-memory-init || true
  if dexec -u ccd ccdash claude mcp list 2>&1 | grep -Eiqw basic-memory; then
    say "basic-memory is registered; project main is the default"
  else
    warn "basic-memory is not registered yet. Run: sudo -u ccdash /usr/local/bin/ccdash-docker exec -u ccd ccdash ccd-memory-init"
  fi
}

SELFTEST="skipped"
selftest() {
  step "11/12 Live self-test"
  if [ "$NO_SELFTEST" -eq 1 ]; then
    say "skipped (--no-selftest)"
    return 0
  fi
  if CCDASH_ENV_FILE="$INSTALL_DIR/.env" CCDASH_DOCKER="$DOCKER_STR" "$CCD" doctor --live; then SELFTEST=pass; else SELFTEST="warnings (see $SELFTEST_JSON)"; warn "self-test reported problems; the install is still usable"; fi
}

summary() {
  step "12/12 Summary"
  local url=${ORIGIN:-http://127.0.0.1:$PORT}
  say "Dashboard:   $url$([ -n "$ORIGIN" ] || printf '  (SSH: ssh -L %s:127.0.0.1:%s you@this-host)' "$PORT" "$PORT")"
  say "Login file:  $LOGIN_FILE"
  if [ "$TOTP_REQUIRED" -eq 1 ]; then factor='TOTP enrolment at the first login'; else factor='Cloudflare Access email one-time code'; fi
  if [ "${CCDASH_SETUP_SKIP_CLAUDE_LOGIN:-0}" = 1 ]; then signin=skipped; else signin='see above'; fi
  say "Second factor: $factor"
  say "Checks:      stack up = pass; login = pass; Claude sign-in = $signin; self-test = $SELFTEST"
  [ "${#WARNINGS[@]}" -eq 0 ] || { say "Warnings:"; printf '  - %s\n' "${WARNINGS[@]}"; }
  say "Next: open the dashboard on your phone and press \"Enable notifications\"."
  say "Log: $LOG"
}

main() {
  if [ "$UNINSTALL" -eq 1 ]; then
    CURRENT="uninstall"
    [ -n "$INVOKER" ] || INVOKER=""
    if ! is_root && [ "${CCDASH_SETUP_ALLOW_NONROOT:-0}" != 1 ]; then die "run with sudo: sudo ./setup.sh --uninstall"; fi
    uninstall
    exit 0
  fi
  preflight
  packages
  ccdash_user
  if [ "$NO_CLOUDFLARE" -eq 0 ] && [ -n "$HOSTNAME_ARG" ] && [[ $HOSTNAME_ARG == *.* ]]; then ORIGIN=https://$HOSTNAME_ARG; fi
  write_env_and_start
  login
  identity
  claude_login
  if [ "$NO_CLOUDFLARE" -eq 0 ]; then
    cloudflare_tunnel
    access_app
    cloudflare_publish
    # recreate the container only if CCDASH_ORIGIN or the second-factor setting changed
    start_stack
  else
    step "8/12 Cloudflare tunnel"
    say "skipped (--no-cloudflare)"
    access_app
  fi
  memory
  selftest
  summary
}
main
