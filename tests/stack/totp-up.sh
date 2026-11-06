#!/usr/bin/env bash
# Starts a throwaway stack (project ccdashtest-t, port CCDASH_TEST_PORT, default 7698) with
# CCDASH_TOTP_REQUIRED=1 and one login, and leaves it running, so the TOTP enrol page and the
# recovery-codes screen can be looked at in a browser. `tests/stack/totp-up.sh down` removes it and its volumes.
# Needs docker (or CCDASH_DOCKER, e.g. "sudo -n -u ccdash /usr/local/bin/ccdash-docker"), curl and tar.
# Env: CCDASH_TEST_PORT, CCDASH_IMAGE (ccdash:ci, built from the checkout if missing).
# shellcheck disable=SC1091 # .env.example is a plain env file
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
D=${CCDASH_DOCKER:-docker} # may contain spaces; left unquoted on purpose
export CCDASH_TEST_PORT=${CCDASH_TEST_PORT:-7698}
base=${CCDASH_IMAGE:-ccdash:ci}
P=ccdashtest-t
export CCDASH_TEST_IMAGE=ccdash-stack:$P
url=http://127.0.0.1:$CCDASH_TEST_PORT
compose() { (cd / && $D compose -p "$P" -f - "$@" < <(sed -e "s|@IMAGE@|$CCDASH_TEST_IMAGE|" -e "s|@PORT@|$CCDASH_TEST_PORT|" -e '/# phase-c$/d' \
  -e 's|^    environment:$|&\n      CCDASH_TOTP_REQUIRED: "1"|' "$root/tests/stack/compose.yaml")); }
tar_ctx() { (cd "$root" && git ls-files -co --exclude-standard -- . ':!dashboard/node_modules' | grep -v '^docs/handoff\|^\.claude' | tar -c -T -); }

if [ "${1:-}" = down ]; then compose down -v --remove-orphans; exit 0; fi

if ! $D image inspect "$base" >/dev/null 2>&1; then
  set -a; . "$root/.env.example"; set +a
  tar_ctx | $D build -q -t "$base" --build-arg "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION" --build-arg "S6_OVERLAY_VERSION=$S6_OVERLAY_VERSION" - >/dev/null
fi
tar_ctx | $D build -q -f tests/Dockerfile.stack --build-arg "BASE=$base" -t "$CCDASH_TEST_IMAGE" - >/dev/null
compose down -v --remove-orphans >/dev/null 2>&1 || true
compose up -d >/dev/null 2>&1
for _ in $(seq 300); do curl -sf "$url/healthz" >/dev/null 2>&1 && break; sleep 0.2; done
curl -sf "$url/healthz" >/dev/null
compose exec -T -u web ccdash node -e "require('/opt/ccdash/dashboard/lib/authstore').setCredentials({dir:'/var/lib/ccdash-web',username:'t',password:'test-password-123'})"
cat <<MSG
Stack $P is up with CCDASH_TOTP_REQUIRED=1.
  URL (from the Docker user's network namespace): $url/login  (the allowed Origin is http://localhost:7690)
  Username t, password test-password-123; after signing in the TOTP enrol page shows, then the recovery codes.
  Browser inside the stack's network namespace (as phase-e does):
    $D run --rm --network container:\$($D ps -qf name=$P-ccdash) ccdash-playwright:ccdashtest-e ...  then open http://localhost:7690/login
  Remove: tests/stack/totp-up.sh down
MSG
