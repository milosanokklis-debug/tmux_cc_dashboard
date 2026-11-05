# ccdash Handoff 2-owner: login, phone and release tasks

## Summary
Everything from Handoff 1 and Handoff 2 that needs the owner in person: logging in, the Cloudflare hostname, a real browser and phone, host package installs, a fresh VM, an arm64 machine, and publishing the release. The agent-only run (`docs/handoff/handoff-2.md`, run file `docs/handoff/runs/handoff-2.md`) has built and tested everything else. Do these after that run finishes. An agent may help with steps marked (agent can help), but the owner has to be present.

## State
- Handoff 2 phases A to H are merged on main through PRs, with branch protection on main (required `test` check, admins included).
- The live container runs the default compose (no egress override, no gVisor), and its volumes were backed up to /home/ccdash/backups before the run.
- Claude Code inside the container was already logged in during the run. If the run file says the login was lost, do Step 2 first.
- Check the run file's Decisions log and "Left for the owner" list. Items the run could not finish are appended at the bottom of this file.

## Decided
- Release: MIT license, images public on GHCR under the owner's GitHub account, unless the owner chooses otherwise in Step 9.
- Egress allowlist and TOTP are built but off. Turning them on is the owner's choice (Steps 7 and 8).
- gVisor was not attempted, because it needs runsc installed on the host.

## Steps

### Step 1: Cloudflare Access and the public hostname
- Goal: reach the dashboard at `https://ccdash.<yourdomain>`, protected by Access.
- Do: follow NOTES.md "Cloudflare Access + cloudflared (owner action)" steps a to e in that order. Create the Access application (Allow, your email, One-time PIN, short session) before the public hostname (HTTP, `http://127.0.0.1:7690`). Set `CCDASH_ORIGIN` in `/home/ccdash/ccdash/.env`, then recreate the container (from Phase G on: `-f compose.yaml -f compose.build.yaml`, or the published image).
- Acceptance: a private window asks for the Access code before the dashboard login page; `curl -I https://ccdash.<yourdomain>/` gives a redirect or 403, not 200.

### Step 2: Dashboard password and Claude login
- Goal: your own dashboard password, and a Claude login that survives restarts.
- Do:
  1. `CCDASH_DOCKER="sudo -n -u ccdash /usr/local/bin/ccdash-docker" ./bin/ccd passwd`
  2. Only if the run file says Claude is logged out: `./bin/ccd login` (same CCDASH_DOCKER), then `/login` in Claude, then `/exit`.
  3. `sudo -u ccdash bash -c 'cd /home/ccdash/ccdash && /usr/local/bin/ccdash-docker compose down && /usr/local/bin/ccdash-docker compose up -d'` (never `down -v`).
- Acceptance: after the down/up, the dashboard login works, and a new conversation starts without asking you to log in.

### Step 3: Handoff 1 manual browser and SSH checks
- Goal: close NOTES.md "Remaining owner tasks".
- Do and check:
  - Typing in the browser terminal appears in an SSH-attached tmux client, and the other way round.
  - Two browser windows on different projects do not switch each other.
  - Disconnect and reconnect 10 minutes later: the session still works.
  - Subagents appear in the tree within 2 s.
  - `/exit` flips the card to "Shell only".
  - Safari over the SSH tunnel (`ssh -L 7690:127.0.0.1:7690 <host>`): does the `__Host-` Secure cookie work on http://localhost? Record the result in NOTES.md.
- Acceptance: each item ticked in NOTES.md, with the date.

### Step 4: Phone checks for controls and push (Handoff 2 Phase A and C)
- Goal: prove Web Push and approvals from a real phone through the Cloudflare hostname.
- Do:
  1. On the phone, open the hostname, log in, open Settings, and turn on notifications (on iOS, first add the page to the Home Screen; iOS Web Push needs that).
  2. Start a conversation and ask for something that needs a permission prompt. Approve it from the phone. Do it again and Deny with a message.
  3. Let a turn finish with the phone locked.
- Acceptance: pushes arrive for the approval request and the finished turn, and show only the project name and status. Approve and Deny reach the right conversation, and Claude shows the deny message. Record the browser and phone model in NOTES.md.

### Step 5: Real token checks for Pull (Phase D)
- Goal: check onboarding and Pull with a real fine-grained GitHub token.
- Do: add a test repo with a fine-grained token (Contents read and write, Metadata read). Pull once. Then revoke or expire the token on GitHub and Pull again.
- Acceptance: the first pull works. After revoking, Pull fails with a clear message and the checkout is unchanged (`git -C /workspace/<proj> rev-parse HEAD` is the same before and after).

### Step 6: gVisor (optional, Phase F item 4)
- Goal: decide whether to run Claude under runsc.
- Do: install gVisor (`runsc`) on the host for the ccdash user's rootless Docker, following gVisor's rootless instructions. Set `CCDASH_RUNTIME=runsc` if the run added that switch; if not, ask an agent to add it (agent can help).
- Acceptance: the container starts, the browser terminal works (node-pty), and Claude runs. Rerun the acceptance tests from Handoff 1 and Handoff 2 under runsc (agent can help). Record the measured slowdown in NOTES.md, or record why you skipped this.

### Step 7: Egress allowlist (optional, Phase F item 3)
- Goal: decide whether the live container runs behind the allowlist proxy.
- Do: `docker compose -f compose.yaml -f compose.egress.yaml up -d` (add compose.build.yaml if you build locally).
- Acceptance: `curl https://example.com` from a Claude session fails; Claude, git pull and phone pushes still work. Keep the override in your deploy command if you want it on for good.

### Step 8: TOTP (optional, Phase F item 1)
- Do: `ccd passwd --totp` (as web, through CCDASH_DOCKER), scan the QR code, enter one code, and store the 10 recovery codes offline.
- Acceptance: login asks for a code after the password; a used code is refused the second time.

### Step 9: Release v0.1 and v0.2
- Goal: publish the images and tag the releases.
- Do:
  1. Decide the repo name (rename to `ccdash`?), license (MIT by default) and image visibility. If you rename, update the README, compose.yaml image names and image.yml (agent can help through a PR).
  2. On a fresh Debian VM, follow only the README to a logged-in dashboard with one onboarded repo. Note every place the README was wrong, and fix them through a PR (agent can help).
  3. `git tag v0.1.0 <commit where Phase G merged> && git push origin v0.1.0`. Watch image.yml publish linux/amd64 and linux/arm64 to GHCR. Set the package to public if you want it public.
  4. On an arm64 machine: `docker run --rm ghcr.io/<owner>/ccdash:v0.1.0 claude --version`, then a full compose up.
  5. Tag v0.2.0 at the commit where Phase H merged, in the same way.
- Acceptance: both tags are on GHCR for both architectures; the arm64 image starts; the README run on the VM reaches the logged-in dashboard.

### Step 10: Agent-kit prerequisite (only if Phase H was partly blocked)
- Goal: finish Phase H item H4 if the run marked it "blocked: kit prerequisite".
- Do: ship `agent-kit.sh ensure <path> [design] [code] --json` (R1 to R13) in the agent-kit repo, then run `claude --agent supervisor "run docs/handoff/handoff-2.md"`, limited to Step 8 H4.
- Acceptance: Phase H's Done-when list is fully ticked.

## Limits
- Never run `compose down -v` on the live project unless you mean to delete everything. Backups are in /home/ccdash/backups.
- Do not paste tokens, the Claude credentials or `.env` contents into a chat with an agent.
- Merges to main go through PRs with green CI. Branch protection includes admins.

## Open questions
- Rename the repo to ccdash before v0.1, or keep tmux_cc_dashboard?
- Keep egress on for good? Keep TOTP on, given that Cloudflare Access already gives a second factor?

## Left over from the agent run
(Filled in by the supervisor at the end of the run.)
