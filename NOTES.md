# ccdash notes (Handoff 1, Step 0 answers)

Items marked TODO need a running container and are filled in by the build/run step.

## Decisions
- Claude Code is installed with `npm install -g @anthropic-ai/claude-code@$CLAUDE_CODE_VERSION` (pinned, system-wide, uses Debian nodejs/npm already required by the dashboard). The native installer was not used because it installs per-user and is harder to pin.
- s6-overlay tarballs are verified against the published `.sha256` files at build time. Arch chosen from TARGETARCH (amd64 -> x86_64, arm64 -> aarch64).
- Root filesystem is read-only (`S6_READ_ONLY_ROOT=1`); writable state is limited to tmpfs /run, /tmp and four named volumes.
- `dashboard/` (Step 2) only authenticates: login/logout, sessions, rate limiting, default deny, WebSocket upgrade guard (no WS endpoints yet). Listens on 0.0.0.0:7690 inside the container; published on host 127.0.0.1 only.
- One runtime dependency: `argon2`, pinned to exactly 0.43.1 (Argon2id is not in Node 20's stdlib). It ships glibc prebuilds for linux-x64 and linux-arm64 (node-gyp-build), so no compiler is needed on trixie. 0.43.1 pulls only @phc/format, node-addon-api and node-gyp-build. Why not 0.45.2: its prebuild targets a newer N-API than Debian trixie's Node 20.19.2 provides; loading it segfaults (exit 139), node-gyp-build then tries to compile, and the image has no make/g++. 0.44.x and later also add `cross-env` and its dependencies. Verified with Node 20.19.2 from trixie's apt (the image's Node, not Node 22): `require('argon2')` hash + verify works in `debian:trixie-slim`, and in the built image as user `web` (`docker build` of this repo succeeded, `npm ci --omit=dev` inside it). Do not switch the image to Node 22. Bumping argon2 needs a re-test with that command.
- The s6 `dashboard/run` now starts with `with-contenv` so `CCDASH_ORIGIN` from compose reaches the server. Not yet verified in a running container.
- `.dockerignore` excludes node_modules so a local install is not copied into the image.

## Step 0 answers
Tested by the container runner: tmux 3.5a-3.5a on trixie; docker 29.9.2 (rootful, dev host), compose v5.6.1.
- tmux version on Debian trixie: 3.5a (>= 3.3, so `server-access` is available). Tested.
- `server-access -a web` plus socket access: the socket was created 0600, so `web` could not connect. tmux ignores umask and always creates the socket 0600. Fixed by a background watcher in tmux/run that polls (0.1s, 30s cap) for the socket and chmods it 0660 (a `run-shell` in /etc/tmux.conf does not work: `tmux -D` loads config only when the first client connects, so a first client from `web` is refused before `server-access -a web` is loaded). After the chmod the same watcher connects one ccd-owned client (`start-server \; display-message -p ok`, up to 10 tries, 0.2s apart) so the config is loaded before web connects. Tested on tmux 3.5a with a scratch socket: with the ping a foreign user is accepted as the first client, without it `access not allowed`; /run/ccdash stays ccd:ccd 0750. /run tmpfs needs `exec` (s6 /init lives there), set in compose.yaml; /tmp stays noexec. Re-test `web` connecting in the container: TODO. `/var/lib/ccdash-git` is setgid (2750 web:ccd) so new files get group ccd; dashboard code should still chgrp token files to ccd with mode 0640. CCDASH_TMUX is exported in tmux/run so panes inherit it.
- s6-overlay 3.2.0.3 tarballs: checksums verified OK.
- Claude Code 2.1.317 installs via `npm install -g`; `DISABLE_AUTOUPDATER` works. Tested.
- /etc/claude-code/managed-settings.json path exists, root-owned, read-only. Tested. Hooks firing (SessionStart/SubagentStart/SubagentStop/SessionEnd) and hook payloads: TODO (needs the user).
- Hook env has TMUX_PANE and CCDASH_TMUX: CCDASH_TMUX was missing from the tmux environment (image ENV only); now exported in tmux/run. Re-verify in container: TODO.
- cap_add CHOWN,SETUID,SETGID,DAC_OVERRIDE,FOWNER,KILL with cap_drop ALL, read_only, no-new-privileges: tested. Dropping CHOWN/DAC_OVERRIDE/FOWNER stops s6 reaching ready; dropping SETUID/SETGID breaks the user switch for the dashboard; KILL is needed for s6 service control (not fully verified). The list stays.
- OPEN ISSUE for Step 3: `#{pane_current_command}` reads `bash` when launched via `bash -lc 'claude ...'` (claude is a child of bash), so the live indicator cannot rely on it. Options: check the child process of `#{pane_pid}` (e.g. via `ps`), or exec claude directly in the pane.
- NOTE for Step 3: tmux prints `access not allowed` but exits 0 for a denied client, so the dashboard must not trust the exit code alone; check the output, or use a command with a meaningful status such as `has-session`.
- First launch of claude shows the theme picker / welcome screen. Tested.
- TODO (need the user): /login persistence across restarts, transcript file mode, folder trust dialog, rootless Docker, cloudflared.
- git credential helper returns token for github.com/<owner>: TODO (needs a token file in /var/lib/ccdash-git/<owner>).

## Dashboard auth (Step 2)
Env var: `CCDASH_ORIGIN` (Cloudflare origin, e.g. https://ccdash.example.com; set in .env, passed by compose, empty by default). http://localhost:7690 is always an allowed Origin.
State in /var/lib/ccdash-web: `auth.json` (0600, argon2id hash, username, generation = random nonce) and `sessions.json` (0600, SHA-256 of session ids). `ccd passwd` writes a new random generation and deletes sessions.json; the running server notices the new auth.json on the next request/30 s sweep, drops all sessions and closes registered sockets.
Assumptions:
- The `__Host-ccdash` cookie is `Secure`; browsers (Chrome, Firefox) accept Secure cookies on http://localhost, so the SSH tunnel http://localhost:7690 works. Not tested in a real browser yet. Safari is not assumed to work.
- The client IP is taken from CF-Connecting-IP when it is a valid IP, else the socket address; this is only safe because the port is reachable only via cloudflared and the loopback tunnel. Local processes in the container (ccd shares the network namespace) can connect directly and spoof it, so the per-client delay can be evaded. The global lockout (50 failures/hour, 15 min lock) still caps brute force at roughly 50 guesses/hour, and ccd can use the same lock to lock the owner out of the dashboard. Accepted for the MVP.
- ccd shares the container's network namespace, so it could bind port 7690 while the dashboard is down and serve a fake login page. Accepted risk for the MVP; mitigation: the dashboard must not crash (corrupt auth.json, socket errors and malformed requests are handled; s6 restarts it).
- Git tokens in /var/lib/ccdash-git/<owner> are readable by ccd by design (the credential helper runs as ccd). Use fine-grained, single-repo tokens with minimal permissions. The helper only answers for protocol https, host github.com and a plain owner name.
- Safari may not accept `Secure` `__Host-` cookies on http://localhost, so the SSH-tunnel route may not work there (use Chrome or Firefox, or the Cloudflare hostname).
- A corrupt, empty or malformed auth.json never crashes the server: at startup it behaves as "no password" (503, run ccd passwd), while running it keeps the previous credentials; both log one line without file contents and retry on the next request. A login whose password changes during verification is discarded (409, no cookie).
- Hardening: requestTimeout 10 s, headersTimeout 5 s, max header size 16 KB; Permissions-Policy, Cross-Origin-Opener-Policy and Cross-Origin-Resource-Policy headers; no HSTS (Cloudflare handles it, and localhost is plain http).
- `ccd-session start` passes the prompt after `--` to claude (claude 2.1.317 accepts `claude -- "-x"` as a prompt), and refuses to attach a project to an existing session of the same name that belongs to a different directory (a.b and a_b both map to claude-a_b).

- Rate-limit counters are in memory (reset on restart). Each login attempt counts as a failure while in flight and is refunded on success.
- Run `ccd passwd` needs a TTY; there is no non-interactive CLI mode (tests call `lib/authstore.setCredentials`).
- `ccd passwd` before the first start works; the server picks up auth.json without a restart.
