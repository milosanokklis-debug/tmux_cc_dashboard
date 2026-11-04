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
- Claude Code 2.1.317 declares engines node >=22 (npm prints EBADENGINE during the image build) but the image uses Debian trixie's Node 20.19.2. Claude started and ran correctly in the final end-to-end test; re-test on any Claude Code upgrade, and consider moving the image to Node 22 if a release stops working.
- /etc/claude-code/managed-settings.json path exists, root-owned, read-only. Tested. Hooks firing (SessionStart/SubagentStart/SubagentStop/SessionEnd) and hook payloads: TODO (needs the user).
- Hook env has TMUX_PANE and CCDASH_TMUX: CCDASH_TMUX was missing from the tmux environment (image ENV only); now exported in tmux/run. Re-verify in container: TODO.
- cap_add CHOWN,SETUID,SETGID,DAC_OVERRIDE,FOWNER,KILL with cap_drop ALL, read_only, no-new-privileges: tested. Dropping CHOWN/DAC_OVERRIDE/FOWNER stops s6 reaching ready; dropping SETUID/SETGID breaks the user switch for the dashboard; KILL is needed for s6 service control (not fully verified). The list stays.
- OPEN ISSUE for Step 3: `#{pane_current_command}` reads `bash` when launched via `bash -lc 'claude ...'` (claude is a child of bash), so the live indicator cannot rely on it. Options: check the child process of `#{pane_pid}` (e.g. via `ps`), or exec claude directly in the pane.
- NOTE for Step 3: tmux prints `access not allowed` but exits 0 for a denied client, so the dashboard must not trust the exit code alone; check the output, or use a command with a meaningful status such as `has-session`.
- First launch of claude shows the theme picker / welcome screen. Tested.
- DONE: rootless Docker under a dedicated `ccdash` host user (see "Host rootless Docker for ccdash").
- TODO (need the user): /login persistence across restarts, transcript file mode, folder trust dialog, cloudflared (see "Cloudflare Access + cloudflared (owner action)").
- git credential helper returns token for github.com/<owner>: TODO (needs a token file in /var/lib/ccdash-git/<owner>).
- Final end-to-end verification passed on a rootful Docker 29.9.2 dev host: build from scratch, 128/128 tests on Node 20.19.2, Step 2 acceptance, core features (ws terminal, tree, FIFO hardening, restart persistence). Rootless Docker under a `ccdash` user is DONE (see "Host rootless Docker for ccdash"). Still host/user tasks: Cloudflare Access + cloudflared; Claude /login persistence; real hook payload fixtures in tests/fixtures/2.1.317/; transcript file mode; folder-trust dialog; Safari cookie check. The full list is in "Remaining owner tasks".

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

## Dashboard server side (Handoff 1, Steps 3-5)
Modules in dashboard/lib: tmux.js (tmux via execFile, /proc process table, ccd-ops poller), projects.js, tree.js, term.js, github.js, api.js (routes), http.js (helpers). Tests inject fake tmux, /proc, ops and pty layers (`services` option of createApp). Paths (/workspace, /home/ccd/.ccdash/agents, /home/ccd/.claude, /run/ccdash/ops) are hard-coded; there are no env overrides for them.
- Routes: GET/POST /api/projects, POST /api/projects/:proj/open, GET /api/tree[?all=1], WS /term/:proj, GET / and /assets/*. Everything except /healthz, /login, /assets/style.css and /assets/login.js needs a session; POSTs need Origin + X-CCDash; WS upgrades need session + Origin. tree timestamps (startedTs, endedTs, startTs, endTs) are unix seconds and the response has a top-level `now` (server time, unix seconds) so the UI can correct client clock skew; hook `ts` input may be ISO-8601 (what agents.sh writes) or epoch seconds. GET /favicon.ico answers 204 no-store without auth.
- Live indicator (resolves the Step 0 open issue): walk /proc children of `#{pane_pid}` looking for comm `claude`. Verified in the container: web can read ccd's /proc (no hidepid) and finds `claude` under `bash -lc`.
- pty library: `node-pty` 1.1.0 (optionalDependencies, so `npm ci` on a dev machine without compilers still works and tests use a fake pty). The Dockerfile has a builder stage (build-essential, python3) that runs `npm ci --omit=dev`, requires node-pty/argon2/ws (build fails if node-pty did not compile) and copies node_modules to the final image; no compilers in the final image. Rejected: @homebridge/node-pty-prebuilt-multiarch (downloads prebuilds from GitHub at install time).
- tmux clone job: `tmux new-window -d -t =_ops: -- ccd-ops <16 hex> ccd-project clone owner/repo`. With several arguments tmux execs them directly (no shell); args with spaces and `;` stay intact (tested on 3.5a). The `_ops` session is created at server start and again before every clone.
- Changed for this: `/run/ccdash/ops` is now 0770 (was 0750) so web can delete the .rc/.log files after reading them; `ccd-ops` sets GIT_TERMINAL_PROMPT=0 and reads /dev/null, because the ops window has a tty and a clone of a missing/private repo otherwise waits for a username for the whole 5 min.
- Terminal sessions: `tmux new-session -t =claude-<name> -s web-<8hex> \; set-option destroy-unattached on` in a pty; closing the socket (or logout, expiry, password change) kills the pty and tmux removes web-*. claude-<name> keeps running.
- Hook fields vs reality: the field names in hooks/agents.sh are still unverified. TODO (needs the user, a Claude login): capture real hook payloads into tests/fixtures/2.1.317/ (SessionStart, SubagentStart, SubagentStop, SessionEnd). Until then dashboard/test/fixtures/agents/ holds synthetic files in the agents.sh output format. `task` uses a `description` field if a hook ever writes one, else the first user message of agent_transcript (only files under /home/ccd/.claude, first 64 KB, 80 chars).
- Known limits: a conversation whose claude was killed without a SessionEnd shows `running` if another claude runs in the same pane and session; xterm 6's DOM renderer injects <style> elements, which the unchanged CSP blocks (public/terminal.js works around it with constructable stylesheets, checked in Chrome only against the library, not the full page); GitHub reachability errors while checking a token return 502, not 400.

### Hardening after review (server side)
- Directories ccd can write (`/home/ccd/.ccdash/agents`, `/run/ccdash/ops`, the transcript root) are read through `lib/safefile.js`: open with `O_NOFOLLOW|O_NONBLOCK`, `fstat` the descriptor, require a regular file, read through that descriptor. A FIFO, symlink or device named `*.jsonl`, `<id>.rc` or `<id>.log` is skipped (an `.rc` that cannot be read counts as "still running" until the timeout) instead of blocking the event loop. The transcript path is realpath-confined to /home/ccd/.claude first and then the realpath itself is opened (no check-then-reopen gap).
- tree.js reads at most the newest 200 `*.jsonl` files (by mtime), at most 512 KB each: a larger file is read from its tail (late stop/end events matter most) plus its first 16 KB (project, win), partial lines dropped. Parsed results are cached by (path, mtime, size). runOp reads `.rc` capped at 16 bytes (a bigger file is not a number) and only the last 4 KB of `.log`.
- `ccd-session` escapes a prompt (any argument) that ends in `;` as `\;`: tmux 3.5a treats a trailing `;` on an argv element as a command separator and silently drops it, while a trailing `\;` is a literal `;`. Checked byte for byte in a real tmux with a stub `claude` (scripts.test.js) for `;`, `\;`, `\\;`, newlines, `$()`, quotes and a leading `-`. An env var or temp file was not needed, because `-e VAR=...` is also an argv element and has the same trailing-`;` rule.
- Terminal WebSockets: the socket is registered with the session registry before `startSession` is awaited, so a logout or expiry in that window destroys it and it never gets a pty; `MAX_TERMS` (16) counts pending starts; a ws ping every 30 s terminates clients that miss a pong; after a terminal ends the `web-*` session is also killed by name (best effort, 1 s later).
- tmux denied (`access not allowed`) or unreachable (`error connecting`) now makes `/api/tree` and `/api/projects` answer 503 `{"error":"tmux unavailable"}` (logged once per outage) instead of showing every conversation as gone. Only `no server running` means "no panes".
- A clone that times out kills its `_ops` window (`new-window -P -F '#{window_id}'` gives the target) and removes its `.rc`/`.log`.
- Token files: a failed chgrp to ccd is logged (never the token), and the file's group and mode are checked before the rename; if it is not group-readable by ccd the request fails with 500.

### Known limitations (review follow-ups)
- Adding a project holds the HTTP request until the clone is done (up to 5 min). Cloudflare closes requests after about 100 s, so a clone that takes longer shows a 524 in the browser while it completes on the server. Opening the project afterwards works, because `ccd-project clone` is idempotent. The API contract is unchanged. A second request for the same repo while one is running shares the first call's result instead of queuing another clone when its prompt and token are identical (none and empty count as equal); with a different prompt or token it gets 409 `a request for this repo is already in progress with different settings`.
- The xterm `<style>` workaround in `public/terminal.js` patches `Document.prototype.createElement` (a `style` element becomes a hidden stub that writes through a constructable stylesheet) and `Element.prototype.setAttribute` for `style`. It is page-wide but only changes behavior for `style` elements and `style` attributes, which nothing else in the app creates. The alternative is to allow `style-src 'unsafe-inline'` in the CSP (simpler, weaker: it also permits injected inline styles); the shim was kept so the CSP stays strict.
- Terminals closed by a password change/logout see close code 1006 (registry destroys the socket) — cosmetic.

- Review fixes (server side): the tree parse cache keeps only the fields fold uses (cleaned, capped; at most 5000 events per file), a file over 512 KB is read as head plus tail without parsing the overlap twice, and the tail's first line is dropped only when it starts mid-line. `firstUserMessage` is cached by (path, mtime, size). A symlinked agents dir or transcript root is refused. tmux "access not allowed" is only recognised on stderr (or as the whole stdout), because stdout carries ccd-controlled text. A tmux `error connecting to <sock> (No such file or directory)` is deliberately not "no panes": it surfaces as 503 `tmux unavailable`. Stale `/run/ccdash/ops/<16 hex>.{rc,log,rc.tmp}` files older than 1 h are swept at startup and every 10 min. `ccd-session` drops an empty prompt. If attaching a terminal throws after the WebSocket upgrade, the socket is closed (no HTTP reject), the pty killed and the slot freed once. `dashboard/test` is removed from the runtime image (`rm -rf test` in the build stage); not run in the image.

### Copy and paste in the browser terminal
- tmux runs with `mouse on`, so a plain drag selects inside tmux (copy-mode). On release tmux copies to its buffer and sends an OSC 52 sequence to the client; `@xterm/addon-clipboard` 0.2.0 (served as `/assets/addon-clipboard.js`, global `ClipboardAddon.ClipboardAddon`) writes it to the browser clipboard. Applications in a pane that emit OSC 52 (with `set-clipboard on` / `allow-passthrough on`) reach the clipboard the same way.
- Shift+drag bypasses tmux mouse mode and uses the browser's native selection (copy with Ctrl+C / Ctrl+Shift+C or the context menu).
- Paste with Ctrl+Shift+V (browser paste into xterm) or the paste button on the terminal view.
- The clipboard API needs a secure context (HTTPS via Cloudflare or localhost) and a user gesture; the browser may ask for clipboard permission, especially for reads (paste button, OSC 52 queries). A refused write is silent.
- Verified on tmux 3.5a with `rootfs/etc/tmux.conf` and TERM=xterm-256color (the server's pty TERM): a copy-mode yank sends `ESC ] 52 ; ; <base64> BEL`. tmux leaves the selection parameter (Pc) empty, and the addon's default provider only writes when Pc is `c`, so the page must construct the addon with a provider that treats an empty Pc as `c`. An application's own `ESC ] 52 ; c ; ...` is forwarded unchanged. No tmux.conf change was needed.
- This deliberately supersedes the handoff's "no extra controls on the terminal view" rule, at the user's request.

## Host rootless Docker for ccdash (DONE, 2026-11-03)
The ccdash stack runs under its own host user, so its Docker daemon is rootless and its container processes map to an unprivileged uid range. Rootful Docker is untouched.

Setup (tested facts):
- Host user `ccdash`: uid 1003, locked password, no extra groups, subuid range starts at 296608 (65536 uids).
- Linger enabled. `user@1003` already delegates cpu, memory and pids (cgroup v2), so no `user@.service.d` drop-in was added.
- Rootless `docker.service` for ccdash: Docker 29.9.2, rootlesskit 3.3.0, slirp4netns networking, overlayfs storage, cgroup v2 systemd driver. Socket `/run/user/1003/docker.sock`.
- Packages added: uidmap, slirp4netns, passt, fuse-overlayfs. docker-ce-rootless-extras and dbus-user-session were already installed.
- Wrapper `/usr/local/bin/ccdash-docker` (root, 0755) runs docker as ccdash.
- `/etc/sudoers.d/ccdash` contains exactly: `agent ALL=(ccdash) NOPASSWD: /usr/local/bin/ccdash-docker`
- Checkout `/home/ccdash/ccdash` on feature/ccdash-steps-3-5 with a private `.env` (`CCDASH_ORIGIN` empty).

Verified:
- Container processes run as host uids in the subuid range: tmux (container uid 1000, ccd) is host 297607, node (uid 999, web) is host 297606. Container root is host uid 1003 (ccdash).
- Read-only root filesystem, not privileged, trimmed capabilities, only named volumes.
- Limits applied in the cgroup: mem 8g, cpu 4, pids 1024.
- Port published as 127.0.0.1:7690 only.
- The tmux socket works for web under rootless.
- `bin/ccd` works with `CCDASH_DOCKER="sudo -n -u ccdash /usr/local/bin/ccdash-docker"`.
- Volumes survive `down` / `up`.

Running commands as ccdash: its home is private, so run from a neutral cwd, for example:
```
sudo -u ccdash bash -c 'cd /home/ccdash/ccdash && /usr/local/bin/ccdash-docker compose up -d'
CCDASH_DOCKER="sudo -n -u ccdash /usr/local/bin/ccdash-docker" ./bin/ccd <command>
```

Undo (in this order; steps 1, 6 and 7 are destructive):
1. Stop the stack and delete its named volumes (the dashboard password, git tokens and Claude login are lost):
   `sudo -u ccdash bash -c 'cd /home/ccdash/ccdash && /usr/local/bin/ccdash-docker compose down -v'`
2. Remove the rootless Docker install:
   `sudo -u ccdash bash -c 'cd /tmp && XDG_RUNTIME_DIR=/run/user/1003 dockerd-rootless-setuptool.sh uninstall'`
3. `sudo loginctl disable-linger ccdash`
4. `sudo systemctl stop user@1003.service`
5. `sudo rm /etc/sudoers.d/ccdash /usr/local/bin/ccdash-docker`
6. `sudo userdel -r ccdash` (removes the home directory, checkout and rootless Docker data). Check `/etc/subuid` and `/etc/subgid` for a leftover `ccdash` line and remove it if present.
7. Optional, only if nothing else needs them: `sudo apt-get remove uidmap slirp4netns fuse-overlayfs passt`

Pre-existing, not changed by this work: `/etc/sudoers.d/agent` does not have mode 0440 (visudo warns). Suggested fix, not applied: `sudo chmod 0440 /etc/sudoers.d/agent`

## Cloudflare Access + cloudflared (owner action)
Do this only after the acceptance tests, which now pass. Create the Access application (step a) before the public hostname (step b), so the login page is never reachable without Access.

This host already runs a remotely managed cloudflared tunnel. Its token is in `/etc/cloudflared/token`; we do not read or modify it. cloudflared runs on the host network and the compose port is bound to 127.0.0.1:7690, so no compose change is needed.

In the Cloudflare Zero Trust dashboard:
a. Access > Applications > Add an application > Self-hosted. Application domain: `ccdash.<yourdomain>`. Add a policy with action Allow and an Include rule Emails = your email. Identity provider: One-time PIN. Session duration: short (for example 1 hour).
b. Networks > Tunnels > the existing tunnel > Public hostname > Add a public hostname: subdomain `ccdash`, domain `<yourdomain>`, Service type HTTP, URL `http://127.0.0.1:7690`.
c. On the host, set `CCDASH_ORIGIN=https://ccdash.<yourdomain>` in `/home/ccdash/ccdash/.env` (for example `sudo -u ccdash nano /home/ccdash/ccdash/.env`), then recreate the container:
   `sudo -u ccdash bash -c 'cd /home/ccdash/ccdash && /usr/local/bin/ccdash-docker compose up -d'`
d. Set the dashboard password:
   `CCDASH_DOCKER="sudo -n -u ccdash /usr/local/bin/ccdash-docker" ./bin/ccd passwd`
e. Verify:
   - In a private browser window, open `https://ccdash.<yourdomain>/`. The Access one-time code prompt must appear before the dashboard login page.
   - `curl -I https://ccdash.<yourdomain>/` without Access auth must not return the dashboard. Expect Access's redirect or a 403, not a 200.
f. Before this is set up, use an SSH tunnel: `ssh -L 7690:127.0.0.1:7690 <host>`, then open http://localhost:7690 in Chrome or Firefox (see the Safari caveat under Dashboard auth).

## Remaining owner tasks
- [ ] Cloudflare Access + cloudflared steps a to e in "Cloudflare Access + cloudflared (owner action)".
- [ ] `ccd login`, then `/login` once. Verify it survives `compose down` and `compose up`.
- [ ] Capture real hook payloads for SessionStart, SubagentStart, SubagentStop and SessionEnd into tests/fixtures/2.1.317/. Check the fields agent_id, agent_type, description and agent_transcript_path, and the transcript file mode.
- [ ] Folder-trust dialog: record its behavior.
- [ ] Safari check of the `__Host-` Secure cookie on http://localhost (SSH tunnel).
- [ ] Manual browser/SSH acceptance:
  - Typing in the browser appears in SSH, and typing in SSH appears in the browser.
  - Two clients in different windows do not switch each other.
  - Disconnect, reconnect 10 minutes later: the session still works.
  - Subagents appear within 2 s.
  - `/exit` flips the card to Shell only.
