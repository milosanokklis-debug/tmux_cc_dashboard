#!/usr/bin/env bash
# shellcheck disable=SC2317 # functions are invoked indirectly (trap, until_ok, helpers)
# Phase F egress on a test compose stack: the real compose.egress.yaml (the production override) layered
# on the test stack, so ccdash sits on an internal network and the only way out is the allowlist proxy.
# A stand-in container on the proxy's outside network plays GitHub (git over http) and a push service
# (https). Checks: example.com fails for ccd (and a DENY line is logged), the dashboard still answers on
# the published loopback port through the forwarder, git clone/pull and the dashboard's web-push send go
# through the proxy (the stand-in is not reachable directly from ccdash), push endpoints outside the
# vendor list are refused, and host/ccdash-egress-allow adds a host with no restart. Needs docker (or
# CCDASH_DOCKER, e.g. "sudo -n -u ccdash /usr/local/bin/ccdash-docker"), curl, jq, openssl and tar. Own
# project and volumes (ccdashtest-egress), removed at the end. Env: CCDASH_TEST_PORT (7691), CCDASH_IMAGE
# (ccdash:ci, built from the checkout if missing), KEEP=1 (leave the stack up), DEBUG=1.
# shellcheck disable=SC2329,SC1091 # functions run through until_ok / trap; .env.example is a plain env file
set -euo pipefail
# shellcheck source=tests/stack/lib-login.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib-login.sh"
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
D=${CCDASH_DOCKER:-docker} # may contain spaces; left unquoted on purpose
PORT=${CCDASH_TEST_PORT:-7691}
base=${CCDASH_IMAGE:-ccdash:ci}
P=ccdashtest-egress
IMG=ccdash-stack:$P
PROXYC=$P-proxy
url=http://127.0.0.1:$PORT
origin=http://localhost:7690
tmp=$(mktemp -d)
chmod 0755 "$tmp" # the Docker user may be someone else: everything it reads lives here, world-readable
jar=$tmp/jar
fail=0

# The compose files, all in $tmp: the test base (phase-c lines dropped), the real egress override with
# the test's container name and port, and the test additions.
sed -e "s|@IMAGE@|$IMG|" -e "s|@PORT@|$PORT|" -e '/# phase-c$/d' "$root/tests/stack/compose.yaml" > "$tmp/base.yaml"
sed -e "s|container_name: ccdash-egress|container_name: $PROXYC|" -e "s|127.0.0.1:7690:7690|127.0.0.1:$PORT:7690|" "$root/compose.egress.yaml" > "$tmp/egress.yaml"
cp -r "$root/egress" "$tmp/egress"
cp "$root/tests/stack/standin.js" "$tmp/standin.js"
cat > "$tmp/test.yaml" <<YAML
services:
  ccdash:
    environment:
      NODE_EXTRA_CA_CERTS: /etc/ccdash-test/standin-ca.pem
      CCDASH_PUSH_HOSTS_EXTRA: standin:8443
    configs:
      - source: standinca
        target: /etc/ccdash-test/standin-ca.pem
  egress:
    environment:
      EGRESS_EXTRA_HOSTS: standin:8080,standin:8443
  standin:
    image: $IMG
    entrypoint: ["node", "/srv/standin.js"]
    networks: [outside]
    configs:
      - source: standinjs
        target: /srv/standin.js
      - source: standincert
        target: /srv/cert.pem
      - source: standinkey
        target: /srv/key.pem
configs:
  standinca: {file: $tmp/cert.pem}
  standinjs: {file: $tmp/standin.js}
  standincert: {file: $tmp/cert.pem}
  standinkey: {file: $tmp/key.pem}
YAML
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
  -days 1 -subj /CN=standin -addext subjectAltName=DNS:standin 2>/dev/null
chmod 0644 "$tmp"/*.pem "$tmp"/*.yaml "$tmp/standin.js"; chmod -R a+rX "$tmp/egress"

compose() { (cd / && $D compose -p "$P" -f "$tmp/base.yaml" -f "$tmp/egress.yaml" -f "$tmp/test.yaml" "$@"); }
ccd() { compose exec -T -u ccd ccdash "$@"; }
cleanup() { [ -n "${KEEP:-}" ] || compose down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
until_ok() { # until_ok SECONDS DESCRIPTION CMD...
  local n=$1 what=$2; shift 2
  for _ in $(seq $((n * 5))); do if "$@" >/dev/null 2>&1; then ok "$what"; return 0; fi; sleep 0.2; done
  bad "$what (timed out after ${n}s)"
  if [ -n "${DEBUG:-}" ]; then compose logs --tail 30 || true; fi
  return 1
}
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; fi; }
refuses() { local what=$1; shift; if "$@" >/dev/null 2>&1; then bad "$what (it succeeded)"; else ok "$what"; fi; }
tar_ctx() { (cd "$root" && git ls-files -co --exclude-standard -- . ':!dashboard/node_modules' | grep -v '^docs/handoff\|^\.claude' | tar -c -T -); }
proxylog() { compose logs --no-log-prefix egress 2>&1; }
standinlog() { compose logs --no-log-prefix standin 2>&1; }
proxy_has() { proxylog | grep -q -- "$1"; }

if ! $D image inspect "$base" >/dev/null 2>&1; then
  set -a; . "$root/.env.example"; set +a
  tar_ctx | $D build -q -t "$base" --build-arg "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION" --build-arg "S6_OVERLAY_VERSION=$S6_OVERLAY_VERSION" --build-arg "BASIC_MEMORY_VERSION=$BASIC_MEMORY_VERSION" --build-arg "KIT_REPO=$KIT_REPO" --build-arg "KIT_REF=$KIT_REF" - >/dev/null
fi
tar_ctx | $D build -q -f tests/Dockerfile.stack --build-arg "BASE=$base" -t "$IMG" - >/dev/null

compose config -q || { echo "FAIL compose config is invalid"; exit 1; }
compose up -d --build >/dev/null 2>&1 || { compose up -d --build; exit 1; }

echo "== topology"
healthy() { curl -sf "$url/healthz"; }
until_ok 90 "dashboard answers on 127.0.0.1:$PORT through the forwarder" healthy
# shellcheck disable=SC2016 # Go template, not shell
nets=$($D inspect "$(compose ps -q ccdash)" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')
eq "ccdash is on the internal network only" "$nets" "${P}_internal "
eq "ccdash publishes no port itself" "$($D inspect "$(compose ps -q ccdash)" --format '{{len .NetworkSettings.Ports}} {{json .HostConfig.PortBindings}}')" "0 {}"
eq "the proxy publishes 127.0.0.1:$PORT" "$($D port "$PROXYC" 7690/tcp)" "127.0.0.1:$PORT"
# shellcheck disable=SC2016 # expanded by the container shell
eq "ccdash has the proxy variables (both cases)" "$(ccd sh -c 'echo $HTTPS_PROXY $https_proxy $HTTP_PROXY $http_proxy')" "http://egress:3128 http://egress:3128 http://egress:3128 http://egress:3128"

compose exec -T -u web ccdash node -e "require('/opt/ccdash/dashboard/lib/authstore').setCredentials({dir:'/var/lib/ccdash-web',username:'t',password:'test-password-123'})"
login() { curl -sf -c "$jar" -H "Origin: $origin" -H 'X-CCDash: 1' -H 'content-type: application/json' \
  -d '{"username":"t","password":"test-password-123"}' "$url/login"; }
until_ok 20 "login" login
api() { local m=$1 p=$2 out; shift 2; local a=(); [ $# -gt 0 ] && a=(-H 'content-type: application/json' -d "$1")
  out=$(curl -s -b "$jar" -X "$m" -H "Origin: $origin" -H 'X-CCDash: 1' ${a[@]+"${a[@]}"} -w '\n%{http_code}' "$url$p")
  printf '%s %s\n' "${out##*$'\n'}" "${out%$'\n'*}"; }
status() { api "$@" | cut -d' ' -f1; }
body() { api "$@" | cut -d' ' -f2-; }

echo "== the way out is the allowlist"
refuses "curl https://example.com as ccd fails (through the proxy)" ccd curl -sS --max-time 20 -o /dev/null https://example.com
refuses "curl https://example.com as ccd fails (proxy bypassed: no route out)" ccd curl -sS --max-time 20 --noproxy '*' -o /dev/null https://example.com
refuses "the stand-in is not reachable directly" ccd curl -sS --max-time 10 --noproxy '*' -o /dev/null http://standin:8080/
until_ok 10 "the proxy log shows DENY example.com:443" proxy_has 'DENY example.com:443'
eq "an allowed host works through the proxy (http, stand-in)" "$(ccd curl -sS --max-time 20 -o /dev/null -w '%{http_code}' 'http://standin:8080/demo.git/info/refs?service=git-upload-pack')" 200
eq "an allowed host works through the proxy (https, stand-in)" "$(ccd curl -sS --max-time 20 --cacert /etc/ccdash-test/standin-ca.pem -o /dev/null -w '%{http_code}' -X POST https://standin:8443/probe)" 201
eq "a CONNECT to an allowed host on a port that is not allowed is refused" "$(ccd curl -sS --max-time 10 -o /dev/null -w '%{http_connect}' -p -x http://egress:3128 http://standin:9999/ 2>/dev/null || true)" 403

echo "== git clone and pull through the proxy (onboarding)"
ccd git config --global url.http://standin:8080/demo.git.insteadOf https://github.com/octo/demo.git
r=$(body POST /api/projects '{"repo":"octo/demo"}')
eq "add clones through the proxy (signed out, so no session yet)" "$(jq -r .session <<<"$r")" null
eq "the clone is in the workspace" "$(ccd cat /workspace/demo/f)" one
stack_login demo
eq "open starts a session once signed in" "$(body POST /api/projects/demo/open | jq -r .session)" claude-demo
check "the proxy log shows the git traffic to the stand-in" proxy_has 'ALLOW standin:8080'
# shellcheck disable=SC2016 # the loop runs in the container's shell
claude_env() { ccd sh -c 'for p in $(pgrep -u ccd -x claude); do tr "\0" "\n" </proc/$p/environ; done' | sort -u; }
up() { claude_env | grep -q '^HTTPS_PROXY=http://egress:3128$'; }
until_ok 20 "Claude (a tmux child) has HTTPS_PROXY in its environment" up
compose exec -T standin sh -ec 'cd /tmp/seed && echo two > f && git -c user.name=seed -c user.email=s@example.com commit -qam two && git push -q origin main'
want=$(compose exec -T standin git -C /srv/git/demo.git rev-parse main | tr -d '\r')
r=$(body POST /api/projects/demo/pull '{}')
if [ "$(jq -r .head <<<"$r")" = "${want:0:7}" ] && [ "$(jq -r .changed <<<"$r")" = true ]; then ok "pull through the proxy advanced to ${want:0:7}"; else bad "pull: $r"; fi
eq "the working tree has the new commit" "$(ccd cat /workspace/demo/f)" two

echo "== web push through the proxy"
sub=$(ccd node -e "
  const c = require('node:crypto'); const e = c.createECDH('prime256v1'); e.generateKeys();
  console.log(JSON.stringify({endpoint: process.argv[1], keys: {p256dh: e.getPublicKey().toString('base64url'), auth: c.randomBytes(16).toString('base64url')}}));" "https://standin:8443/push/abc")
eq "subscribe to the stand-in push endpoint (extra host)" "$(status POST /api/push/subscribe "$(jq -nc --argjson s "$sub" '{subscription: $s}')")" 200
for bad_ep in https://example.com/x https://169.254.169.254/latest https://127.0.0.1/x https://fcm.googleapis.com.evil.example/x http://fcm.googleapis.com/x https://fcm.googleapis.com:8443/x; do
  eq "subscribe refuses $bad_ep" "$(status POST /api/push/subscribe "$(jq -nc --argjson s "$sub" --arg e "$bad_ep" '{subscription: ($s + {endpoint: $e})}')")" 400
done
eq "subscribe accepts a real vendor host" "$(status POST /api/push/subscribe "$(jq -nc --argjson s "$sub" '{subscription: ($s + {endpoint: "https://fcm.googleapis.com/fcm/send/abc"})}')")" 200
eq "subscribe to the stand-in again (the vendor one replaced it)" "$(status POST /api/push/subscribe "$(jq -nc --argjson s "$sub" '{subscription: $s}')")" 200
ccd mkdir -p /workspace/pushy
stack_login pushy
ccd ccd-session start pushy >/dev/null
is_status() { [ "$(live pushy '.status // empty')" = "$1" ]; }
until_ok 30 "pushy is waiting" is_status waiting
api POST "/api/conversations/$(live pushy '.sid')/prompt" '{"text":"/perm"}' >/dev/null
until_ok 15 "pushy waits for approval" is_status needs_approval
got_push() { standinlog | grep -q '^PUSH POST /push/abc '; }
until_ok 20 "the push reached the stand-in (the dashboard cannot reach it except through the proxy)" got_push
check "the proxy log shows ALLOW standin:8443" proxy_has 'ALLOW standin:8443'

echo "== adding a host"
code() { ccd curl -s --max-time 10 -o /dev/null -w '%{http_code}' -x http://egress:3128 http://later.test/; }
eq "later.test is denied at first" "$(code)" 403
CCDASH_DOCKER="$D" CCDASH_EGRESS_CONTAINER="$PROXYC" "$root/host/ccdash-egress-allow" later.test >/dev/null
eq "later.test is let through after ccdash-egress-allow (the proxy answers 502: no such host)" "$(code)" 502
refuses "ccdash-egress-allow refuses a bad host" env CCDASH_DOCKER="$D" CCDASH_EGRESS_CONTAINER="$PROXYC" "$root/host/ccdash-egress-allow" 'a;b'
eq "the dashboard still answers through the forwarder" "$(curl -s -o /dev/null -w '%{http_code}' "$url/healthz")" 200
exit $fail
