# ccdash Handoff 2 (agent-only edition): Everything after the MVP

Based on "ccdash Handoff 2 — Everything after the MVP" (Nov 5, 2026, @Lauren). Edited on 2026-11-05 so that an agent can run it from start to finish without the owner logging in or doing anything. Every step that needs the owner (phone, Cloudflare, a fresh VM, publishing, host package installs) moved to `docs/handoff/handoff-2-owner.md`. That handoff is written, not run.

## Summary
This takes the working MVP from Handoff 1 to a release-ready v0.1, then to agent orchestration. It adds conversation status and wake, browser controls with approvals, pull, usage and token views, extra hardening, release files, and the Basic Memory/agent-kit integration. The security model from Handoff 1 does not change.

## State (checked 2026-11-05)
- Repo: github.com/milosanokklis-debug/tmux_cc_dashboard. `gh` is logged in with ADMIN permission. `main` has no branch protection.
- Local branch `chore/agent-kit-0.9.1` (clean) is 5 commits ahead of `main` and `origin/main`, 0 behind, and is not on origin. It holds all of Handoff 1 plus agent-kit 0.9.1.
- No `.github/workflows`, no top-level `tests/`. The dashboard tests are `cd dashboard && npm test` (`node --test test/*.test.js`).
- Host has docker 29.9.2, compose v5.6.1, node 22, jq, tmux and curl. shellcheck and bats are NOT installed: run them with Docker images (`koalaman/shellcheck`, `bats/bats`), never with host installs.
- Live container `ccdash` (image ccdash:0.1.0) is running under rootless Docker through `sudo -n -u ccdash /usr/local/bin/ccdash-docker`. The deploy dir is `/home/ccdash/ccdash`, and the port is 127.0.0.1:7690.
- Claude Code 2.1.317 inside the container is logged in (a credentials file exists for ccd in the `ccdash-home` volume). Real Claude sessions can run inside the container as ccd without the owner.
- NOTES.md still lists Handoff 1 TODOs and "Remaining owner tasks". The run covers the ones that need only the running container and the logged-in Claude. The owner handoff covers the rest.
- Liveness note from Handoff 1: `#{pane_current_command}` reads `bash` because Claude runs under `bash -lc`. Use the existing /proc child walk (dashboard/lib/tmux.js) wherever this doc says "pane runs Claude".

## Decided (changes against the original doc)
1. The owner asked for this to run with no input from them. The Handoff 1 entry gate ("every acceptance test passes") is replaced by Step 0, which runs every Handoff 1 check that can be automated. The manual browser and phone checks go to the owner handoff.
2. Real-Claude checks run in the live `ccdash` container, as ccd, in a scratch project `/workspace/_h2probe` driven through tmux (send-keys/capture-pane). Keep each probe short, because it uses the owner's Pro plan. Delete the scratch project at the end.
3. Dashboard end-to-end tests run against a separate test stack (compose project `ccdashtest`, port 127.0.0.1:7691, its own volumes, a fake `claude` on PATH). The stack is removed afterwards. Never change the live instance's dashboard password, auth.json or sessions.
4. The live container is redeployed from `main` after each phase that changes the image: `cd /home/ccdash/ccdash`, update the checkout from origin/main, then `ccdash-docker compose ... up -d --build`. Volumes are kept. Step 0 takes a backup of all four volumes first (tar files in /home/ccdash/backups, mode 0600, never committed, never read for content).
5. Merging: Step 0 pushes Handoff 1 and these handoff docs straight to `main` (the owner allowed this). After that, every change goes through a PR with green CI. Branch protection is turned on with `enforce_admins: true`, so nobody can push to main directly. The orchestrator merges with `gh pr merge --squash --delete-branch` only when every check is green.
6. Phase G is "release-ready" only. It adds the README, LICENSE (MIT), SECURITY.md, image.yml and the compose switch, but it does NOT push a tag, publish to GHCR or rename the repo. Tagging v0.1/v0.2 and publishing are owner tasks.
7. Open decisions use the original defaults, with one change. Kit commits and Pull: rebase only over ccdash-authored commits that touch only `.claude/` and `CLAUDE.md`. TOTP: built, off until `ccd passwd --totp`. License: MIT. Egress allowlist (changed): built as an opt-in compose override (`compose.egress.yaml`), verified on the test stack and briefly on the live container, then the live container goes back to the default (off). Turning it on for good is an owner task.
8. gVisor (Phase F item 4) is not attempted, because installing runsc on the host is a host package install. Phase A records "not checked (owner)" for it.
9. Web Push: the mechanism is built and tested against a local fake push endpoint. Delivery to a real phone is an owner task.
10. Usage pacing: the "stop at 80 % of the 5-hour gauge" rule is replaced by run-file resume. If a usage limit stops the run, resume from the run file.
11. Phase H depends on agent-kit shipping `agent-kit.sh ensure <path> [design] [code] --json` (R1 to R13). Phase H starts by checking this at the chosen KIT_REF. If it is missing, build only the shared Basic Memory part (H1 to H3 below), mark the kit hook point blocked, and add it to the owner handoff. This does not stop the run.

## Conventions inherited from Handoff 1 (do not change them)
| Thing | Value |
|---|---|
| Users | Claude and tmux run as ccd; dashboard runs as web, a member of group ccd; ccd cannot read web's files |
| tmux | Socket /run/ccdash/tmux.sock; every call is `tmux -S /run/ccdash/tmux.sock …` via execFile argv; hidden sessions `_ops` and `web-*` |
| Jobs as ccd | `ccd-ops <16 hex> <cmd> [args]` in a new `_ops` window; result in /run/ccdash/ops/<id>.{log,rc} |
| Hook files | Under ~/.ccdash/, written with umask 027, never read back by Claude |
| Managed settings | /etc/claude-code/managed-settings.json (rootfs/etc/claude-code/managed-settings.json in the repo); this handoff adds entries |
| Pinned Claude Code | 2.1.317 with DISABLE_AUTOUPDATER=1; fixtures in tests/fixtures/2.1.317/ |
| Port | 127.0.0.1:7690 only |
| Auth | Every new route requires a session; every new POST needs an allowed Origin and `X-CCDash: 1`; every new WebSocket checks cookie and Origin |

Still out of scope: more than one dashboard-created conversation per project (worktrees), multi-user accounts, dev-server port forwarding, long-running/longevity tests. No built-in waits: tests use short timeouts set through environment variables.

## Branches, commits and PRs (every phase)
1. Each phase starts on a fresh branch from the latest `main`: h2/a-verify, h2/b-state, h2/c-controls, h2/d-pull, h2/e-usage, h2/f-hardening, h2/g-release, h2/h-orchestration.
2. Commit at every working step with a Conventional Commits message, and push the branch after each commit.
3. When the phase's Done-when list passes, run `gh pr create --base main`, titled `Handoff 2 · Phase <X>: <name>`. The body holds the Done-when checklist (each box ticked, or marked "owner" with a pointer to the owner handoff), the test commands run with their results, NOTES.md changes, and deviations from this doc.
4. `gh pr checks --watch`. On failure, fix with new commits on the same branch and wait again.
5. Merge on all-green with `gh pr merge --squash --delete-branch`. Then `git checkout main && git pull`, redeploy the live container if the image changed (Decided 4), and start the next phase.
6. Never merge with a red or pending check. Never use `--admin`, `--no-verify` or skipped checks. Never commit to main directly after Step 0. Never force-push a branch with an open PR.
7. If CI stays red after three fix attempts, or a Done-when box that is not marked "owner" cannot be ticked: leave the PR open, write what failed at the top of its body, and stop.

## Steps

### Step 0: Baseline and push Handoff 1
- Goal: get Handoff 1 onto main, protect the live data, and close the Handoff 1 TODOs that the running container can answer.
- Do:
  1. Fast-forward `main` to `chore/agent-kit-0.9.1` (plus a commit adding `docs/handoff/handoff-2.md`, `docs/handoff/handoff-2-owner.md` and `docs/handoff/runs/handoff-2.md`) and push main. Delete the local chore branch afterwards (it was never pushed and is fully merged).
  2. Back up the four live volumes to /home/ccdash/backups/<date>-<volume>.tgz (mode 0600), using the README's `docker run --rm -v <vol>:/v -v <dir>:/b debian tar czf …` form through ccdash-docker.
  3. Recreate the live container (`compose up -d --force-recreate`, volumes kept). Confirm Claude is still logged in: credentials file present (yes/no only), plus `claude -p "reply ok"` as ccd returns ok.
  4. Run `cd dashboard && npm test` and the scripted Handoff 1 core-feature checks (ws terminal, tree, restart persistence) against a test stack.
  5. Fill the Handoff 1 TODOs in NOTES.md that the running container answers: hooks firing and real payloads for SessionStart/SubagentStart/SubagentStop/SessionEnd (into tests/fixtures/2.1.317/), CCDASH_TMUX in hook env, web connecting to the tmux socket, transcript file mode, folder-trust dialog behavior, /login persistence across a recreate. Capture payloads with a temporary tee hook given to Claude through `claude --settings <file>` in /workspace/_h2probe. Never change managed settings for this. These NOTES.md/fixture changes ride in the Phase A PR, not on main directly.
- Acceptance: origin/main contains the Handoff 1 commits and the handoff docs; the backups exist; Claude answers after the recreate; npm test is green.

### Step 1: Phase A — Verify the new assumptions (branch h2/a-verify)
Check Claude Code 2.1.317's behavior in the live container, commit fixtures, and record the answers in NOTES.md before any Phase B code. Phase A's PR carries only the CI workflow, fixtures and NOTES.md. If a check fails, say so in the PR and stop. Do not work around it in later phases.

Hook payloads (tests/fixtures/2.1.317/), captured from real runs in /workspace/_h2probe:
- [ ] One real payload each for UserPromptSubmit, PostToolUse, Notification permission_prompt, Notification idle_prompt, PermissionRequest, Stop, StopFailure. If StopFailure cannot be triggered without breaking the login, record a doc-derived synthetic payload, mark it synthetic in its filename and in NOTES.md, and say so in the PR.
- [ ] One status-line payload. Confirm whether it carries rate_limits (5-hour and 7-day used percent plus reset time) on this Pro plan.

Behavior:
- [ ] Stop does not fire on Esc. Does idle_prompt fire afterwards? (Use a short idle setting if one exists, otherwise record the documented delay without waiting it out.)
- [ ] Does `claude --resume <id>` keep the same session id or mint a new one?
- [ ] PermissionRequest: exit 0 with no output shows the normal dialog; the JSON allow and deny decisions are honored; what happens at the hook timeout (use a hook with a short timeout).
- [ ] SessionStart fires with source `compact` mid-turn (or record that it could not be forced cheaply).
- [ ] Longest prompt tmux accepts as one argv element to respawn-pane and new-session (Handoff 1 capped it at 4,000).
- [ ] `paste-buffer -p` delivers a multi-line prompt to Claude as one bracketed paste, without submitting each line.
- [ ] The exact `claude mcp add` syntax for a user-scope stdio server on 2.1.317, and the `claude mcp list` output format (for Phase H).

Environment:
- [ ] Hosts contacted by Claude Code, git and npm during a normal session. Log them through a temporary proxy (a tinyproxy/squid container on the test stack, or HTTPS_PROXY on a probe Claude in the live container). This list is the start of Phase F's allowlist.
- [ ] Whether a proxy container can publish 127.0.0.1:<port> and forward to a container on an `internal: true` network under this rootless Docker (needed for Phase F egress). Test it on throwaway containers.
- [ ] gVisor: record "not checked; needs runsc on the host (owner)".
- [ ] Web Push to a phone: record "owner" (see the owner handoff).

CI first:
- [ ] `.github/workflows/test.yml`, one job named `test`, on every push and pull request. It runs shellcheck on every script, the bats tests, the dashboard's `node --test`, a replay of every fixture through the hooks, and an image build without pushing. Later phases add their tests to this job.
- [ ] After the Phase A PR is green and before merging it, turn on branch protection for `main`: require PRs, require the `test` status check (strict), block force-pushes and deletions, `enforce_admins: true`, no required reviews. Then prove it works: open a throwaway PR (branch h2/a-protection-probe) with a deliberately failing test, confirm `gh pr merge` refuses it, close the PR and delete that branch.
- Acceptance: every box ticked or explicitly marked owner/synthetic in NOTES.md and the PR; PR merged on green.

### Step 2: Phase B — State, liveness and wake (branch h2/b-state)
Hooks record facts per conversation. The dashboard derives status from those facts plus a live tmux check every 5 seconds. Idle conversations are flagged, never killed, and any stopped conversation can be woken with its full history.

| Status | Set by | Meaning |
|---|---|---|
| working | UserPromptSubmit, PostToolUse | Claude is busy |
| needs_approval | Notification permission_prompt, PermissionRequest | Blocked on you |
| waiting | Stop, Notification idle_prompt, SessionStart | At the prompt |
| error | StopFailure | The turn failed |
| ended | SessionEnd | Claude exited normally |
| sleeping | Reconciler | Process gone without SessionEnd |
| idle flag | Reconciler | waiting longer than CCDASH_IDLE_FLAG (default 2 h) |
| quiet flag | Reconciler | working with no event for CCDASH_QUIET_AFTER (default 900 s) |

state.sh (`/usr/local/lib/ccdash/hooks/state.sh <status>`; never blocks or fails Claude):
```bash
#!/usr/bin/env bash
set -uo pipefail
umask 027
base=$HOME/.ccdash; dir=$base/sessions; mkdir -p "$dir"
exec 2>>"$base/hook.log"
in=$(cat)
sid=$(jq -r '.session_id // empty' <<<"$in") || exit 0
[ -n "$sid" ] || exit 0
f=$dir/$sid.json; prev='{}'; [ -s "$f" ] && prev=$(cat "$f")
srv=""; [ -n "${TMUX:-}" ] && srv=$(tmux display -p '#{pid}' 2>/dev/null || true)
tmp=$(mktemp "$dir/.$sid.XXXXXX")
jq -n --argjson prev "$prev" --argjson in "$in" --arg state "$1" \
      --arg pane "${TMUX_PANE:-}" --arg srv "$srv" --arg proj "${CLAUDE_PROJECT_DIR:-}" \
      --arg from "${CCDASH_RESUMED_FROM:-}" --argjson now "$(date +%s)" '
  $prev + {
    sid: $in.session_id,
    project: ($prev.project // (if $proj != "" then $proj else $in.cwd end)),
    transcript: $in.transcript_path,
    state: $state, event: $in.hook_event_name, ts: $now,
    pane: (if $pane != "" then $pane else $prev.pane end),
    tmux_pid: (if $srv != "" then ($srv | tonumber) else $prev.tmux_pid end),
    waiting_since: (if $state == "waiting"
                    then (if $prev.state == "waiting" then $prev.waiting_since else $now end)
                    else null end)
  } + (if $from != "" then {resumed_from: $from} else {} end)' > "$tmp" && mv "$tmp" "$f"
exit 0
```
- The project dir is written once and never overwritten. The tmux server pid sits beside the pane id (pane ids restart at %0 with each server). Writes are atomic. Use `tmux -S "$CCDASH_TMUX"` if plain `tmux` does not reach the right socket in the hook env (Step 0 answer). If jq is missing, `$(...)` fails and the script exits 0 without output. Make sure the mktemp file is removed on failure.

Managed settings additions (merge in, and keep the four agents.sh entries):
```json
{
  "hooks": {
    "SessionStart":     [{ "matcher": "startup|resume", "hooks": [{ "type": "command", "command": "/usr/local/lib/ccdash/hooks/state.sh waiting" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/usr/local/lib/ccdash/hooks/state.sh working" }] }],
    "PostToolUse":      [{ "hooks": [{ "type": "command", "command": "/usr/local/lib/ccdash/hooks/state.sh working" }] }],
    "Notification": [
      { "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "/usr/local/lib/ccdash/hooks/state.sh needs_approval" }] },
      { "matcher": "idle_prompt",       "hooks": [{ "type": "command", "command": "/usr/local/lib/ccdash/hooks/state.sh waiting" }] }
    ],
    "Stop":        [{ "hooks": [{ "type": "command", "command": "/usr/local/lib/ccdash/hooks/state.sh waiting" }] }],
    "StopFailure": [{ "hooks": [{ "type": "command", "command": "/usr/local/lib/ccdash/hooks/state.sh error" }] }],
    "SessionEnd":  [{ "hooks": [{ "type": "command", "command": "/usr/local/lib/ccdash/hooks/state.sh ended" }] }]
  }
}
```
SessionStart matches only startup|resume. A compact start fires mid-turn and would flip a busy conversation to waiting.

Reconciler (inside the dashboard, every 5 s, read-only on state files):
1. Stored tmux_pid differs from the running server's pid → sleeping.
2. Pane gone, or the pane no longer runs Claude (/proc child walk) → sleeping, unless the last event was SessionEnd.
3. waiting and waiting_since older than the idle threshold → idle flag.
4. working with no event for CCDASH_QUIET_AFTER → quiet flag.
5. Hide a conversation whose id appears as another's resumed_from.
6. No pane → "outside tmux" badge, skip liveness.

The dashboard keeps derived status in memory and never writes hook files. The agent tree takes each conversation's status from here instead of its own running/ended/gone rule.

Wake (`ccd-session wake <session-id>`; the dashboard's Wake button and `ccd wake` call it):
```bash
  wake)
    sid=${2:?session id}
    [[ $sid =~ ^[0-9a-f-]{36}$ ]] || { echo "bad session id" >&2; exit 2; }
    dir=$(jq -r .project "/home/ccd/.ccdash/sessions/$sid.json")
    [[ $dir == /workspace/* && -d $dir ]] || { echo "project gone: $dir" >&2; exit 1; }
    name=$(name_for "$dir")
    if t has-session -t "=$name" 2>/dev/null; then
      t new-window -t "=$name:" -c "$dir" -e "CCDASH_RESUMED_FROM=$sid" "${cmd[@]}" --resume "$sid"
    else
      t new-session -d -s "$name" -c "$dir" -e "CCDASH_RESUMED_FROM=$sid" "${cmd[@]}" --resume "$sid"
      t set -t "=$name" @project_dir "$dir"
    fi
    echo "$name" ;;
```
Adapt this to the real ccd-session. It already `shift`s the subcommand, so the id is `$1` there, and `cmd` passes args after `--`, so `--resume` must come before `--` in the command. Keep `CCDASH_WS` test overrides. Resume runs from the original folder. The UI says, next to Wake, that an interrupted step does not continue and processes Claude started do not come back. Add `wake)` to the host `bin/ccd`.

Done when:
- [ ] Scripted runs (fixture replay plus a real probe) show the right status for a prompt, a tool call, a permission prompt, a finish and an Esc interrupt. Tests use CCDASH_QUIET_AFTER=5 and CCDASH_IDLE_FLAG=5.
- [ ] kill -9 on Claude shows sleeping within 10 s; a container restart (test stack, plus one live recreate) shows every conversation sleeping.
- [ ] Wake restores full history both when the tmux session still exists and when it is gone (real probe in the live container).
- [ ] A woken conversation replaces its old record (no duplicate).
- [ ] With jq removed (test image or PATH without jq), Claude still runs with no hook error shown.

### Step 3: Phase C — Controls, approvals and notifications (branch h2/c-controls)
| Control | Mechanism | Allowed when |
|---|---|---|
| Prompt box | `tmux load-buffer -b <random id> -` with text on stdin, then `paste-buffer -p -d -b <id> -t <pane>`, then `send-keys -t <pane> Enter` | waiting |
| Slash commands | same, text starting with / | waiting |
| Approve / Deny | permission broker | a request is pending |
| Interrupt | `send-keys -t <pane> Escape` | working or needs_approval |
| Close | paste /exit + Enter so SessionEnd fires; kill-pane after 10 s if not ended; confirm first | any live status |
| Wake | ccd-session wake (Phase B) | sleeping or ended |

Refuse prompts longer than the Phase A limit with a clear message. Never log prompt text. Project-list previews come from `capture-pane -p -e -t <pane>`, fetched only for cards on screen.

Permission broker:
1. permission.sh runs with the tool name and input, marks the conversation needs_approval, and posts to /run/ccdash-web/broker.sock.
2. It waits up to CCDASH_APPROVAL_WAIT (default 120 s). The hook timeout is 150 s.
3. A dashboard click returns allow or deny (deny may carry a message).
4. On timeout, a broker that is down, or any error: exit 0, no output, normal terminal dialog.
5. /run/ccdash-web is created by init-ccdash as web:ccd 0750, and the socket is web:ccd 0660. It is never on TCP and accepts only POST /permission (no approve route). The broker drops requests with no state file or a mismatched pane, and allows one pending request per conversation.
```bash
#!/usr/bin/env bash
# /usr/local/lib/ccdash/hooks/permission.sh
in=$(cat)
/usr/local/lib/ccdash/hooks/state.sh needs_approval <<<"$in" || true
resp=$(curl -sf --max-time "${CCDASH_APPROVAL_WAIT:-120}" --unix-socket /run/ccdash-web/broker.sock \
         -H 'content-type: application/json' --data-binary @- http://broker/permission <<<"$in") || exit 0
case $(jq -r '.behavior // empty' <<<"$resp" 2>/dev/null) in
  allow|deny)
    jq -c '{hookSpecificOutput: {hookEventName: "PermissionRequest",
             decision: ({behavior: .behavior} + (if .message then {message: .message} else {} end))}}' <<<"$resp" ;;
esac
exit 0
```
Managed settings: `"PermissionRequest": [{ "hooks": [{ "type": "command", "command": "/usr/local/lib/ccdash/hooks/permission.sh", "timeout": 150 }] }]`. Adjust the output shape to what Phase A recorded. The approval card shows project, conversation, tool name and tool input, with Approve, Deny and an optional deny message. It disappears when the conversation leaves needs_approval.

Push notifications: use the `web-push` npm package (pinned). VAPID keys are generated on first start and kept with the subscriptions in ccdash-web (0600). Serve a service worker at /sw.js. Subscribing needs a session. Push on needs_approval, error, and working → waiting, with a settings page toggle for each. The payload holds only the project name and status. Logout or a password change deletes that browser's subscription.

Done when:
- [ ] A prompt with quotes, `$(...)`, `;`, newlines and the word "Enter" arrives verbatim (real probe in the live container, plus a unit test of the argv/stdin).
- [ ] The prompt box is disabled unless the status is waiting.
- [ ] Approve and Deny reach the right conversation, and a deny message reaches Claude (scripted HTTP against the dashboard plus a real probe; the phone part is owner).
- [ ] With CCDASH_APPROVAL_WAIT=5, an unanswered request shows the terminal dialog; killing the dashboard mid-wait also falls through.
- [ ] From inside Claude (as ccd), posting to the broker socket cannot produce an allow.
- [ ] Interrupt stops a running turn; Close ends as ended, or kills the pane after 10 s.
- [ ] A push for an approval request and a finished turn reaches a local fake push endpoint, decrypts, and contains only project and status (real phone: owner).

### Step 4: Phase D — Re-onboarding with pull, git identity (branch h2/d-pull)
`ccd-project pull` (beside clone):
```bash
  pull)   # ccd-project pull <project>
    proj=${2:?project}; [[ $proj =~ ^[A-Za-z0-9_.-]+$ && $proj != *..* ]] || exit 2
    git -C "/workspace/$proj" pull --ff-only ;;
```
(Match ccd-project's real argument handling and its CCDASH_WS-style test overrides.)

`ccd-onboard <owner/repo>` (run through ccd-ops):
```bash
#!/usr/bin/env bash
set -euo pipefail
repo=${1:?owner/repo}
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $repo != *..* ]] || { echo "bad repo name" >&2; exit 2; }
proj=${repo#*/}; dir=/workspace/$proj
if [ -d "$dir/.git" ]; then
  [ "$(git -C "$dir" remote get-url origin)" = "https://github.com/$repo.git" ] \
    || { echo "$dir belongs to a different repo" >&2; exit 3; }
  [ -z "$(git -C "$dir" status --porcelain)" ] \
    || { echo "uncommitted changes in $dir; commit or stash first" >&2; exit 3; }
  echo "[onboard] pulling $repo"; ccd-project pull "$proj"
else
  echo "[onboard] cloning $repo"; ccd-project clone "$repo"
fi
umask 027; mkdir -p "$HOME/.ccdash/projects"
jq -n --arg repo "$repo" --arg head "$(git -C "$dir" rev-parse HEAD)" --argjson ts "$(date +%s)" \
      '{repo: $repo, head: $head, ts: $ts}' > "$HOME/.ccdash/projects/$proj.json"
echo "[onboard] done"
```
Flow changes: POST /api/projects runs ccd-onboard instead of clone (the token check stays). New POST /api/projects/:proj/pull reads owner/repo from ~/.ccdash/projects/<proj>.json and runs ccd-onboard; the card shows the job log and the new short HEAD. A live Claude is never restarted or prompted ("pulled; Claude was not restarted"). `ccd pull <project>` on the host CLI does the same. Preserve existing keys (e.g. packs, Phase H) when rewriting the project json.

Git identity: a settings form (name up to 100 printable characters, email matching a basic x@y.z pattern) runs `ccd-ops <id> git config --global user.name <name>` and the same for user.email. web never writes into ccd's home.

Done when (tests use local bare repos with `url.<local>.insteadOf https://github.com/`, no real GitHub token):
- [ ] Adding an existing repo again fast-forwards it and leaves a running Claude untouched.
- [ ] Pull refuses a dirty tree, a folder of a different repo, and a diverged branch, each with a clear message.
- [ ] A remote that refuses access (simulated: credentials rejected or remote unreadable) makes Pull fail without changing the checkout. A real expired GitHub token is an owner check.
- [ ] A commit Claude makes after setting the identity shows that name and email (real probe in /workspace/_h2probe, with a test identity; restore the previous identity afterwards).

### Step 5: Phase E — Usage, tokens and optimization (branch h2/e-usage)
| Source | Gives | Notes |
|---|---|---|
| Status-line payload (statusline.sh) | rate_limits 5-hour and 7-day used percent with reset; cost; context window; model | Primary. Account gauges use the freshest reading. Missing field → "unknown", never guess |
| Transcripts (~/.claude/projects/…/*.jsonl) | per-message tokens by model | Parse tolerantly; test against fixtures |
| SubagentStart/Stop | agent_id, agent_type, agent_transcript_path | ties tokens to tree nodes |

```bash
#!/usr/bin/env bash
umask 027
in=$(cat); d=$HOME/.ccdash/usage; mkdir -p "$d"
sid=$(jq -r '.session_id // empty' <<<"$in")
if [ -n "$sid" ]; then
  jq -c --argjson ts "$(date +%s)" '{ts: $ts, rate_limits, cost, context_window, model}' <<<"$in" > "$d/.$sid.tmp" \
    && mv "$d/.$sid.tmp" "$d/$sid.json"
fi
if [ -n "${CCDASH_STATUSLINE_CMD:-}" ]; then printf '%s' "$in" | bash -c "$CCDASH_STATUSLINE_CMD"
else jq -r '"\(.model.display_name) · ctx \(.context_window.used_percentage // "?")%"' <<<"$in"; fi
```
Managed settings: `"statusLine": { "type": "command", "command": "/usr/local/lib/ccdash/hooks/statusline.sh" }`.

Transcripts: if Step 0 found them group-readable, web reads them directly. If they are 0600, add an s6 service `ccd-reader` as ccd on /run/ccdash/reader.sock (ccd:ccd 0660). It serves two read-only calls (tail, and read from an offset), resolves paths with realpath, and refuses anything outside /home/ccd/.claude/projects/.

Views: session and weekly gauges with reset countdowns; tokens by 5-hour window, project, conversation, model and agent (input, output, cache creation, cache read). Dollar figures are labelled "API-price estimate, not billing". Build the /usage fallback only if Phase A showed rate_limits missing: a hidden claude in an `_ops` window with CCDASH_HIDDEN=1 (hooks skip it), paste /usage, capture-pane, /exit, at most once per 10 minutes.

Richer agent tree: model, Phase B status, elapsed time and tokens per node. Clicking a subagent opens a read-only panel tailing its transcript.

Optimization: incremental reads by byte offset and inode (re-read from 0 when the inode changes). Replace client polling with one logged-in WebSocket, /events (cookie + Origin checked). The server uses fs.watch on ~/.ccdash/ with the 5 s reconciler as backstop. Previews only for visible cards (IntersectionObserver), at most once per second per card. Token totals cached in memory and rebuilt from offsets after restart. Target: under 3 % of one CPU and under 200 MB RSS with 10 conversations.

Done when:
- [ ] Gauges match `/usage` (run in a real probe Claude) within one percentage point.
- [ ] Removing rate_limits from a fixture shows "unknown".
- [ ] A spawned subagent appears in the tree within 2 s and opens its transcript (real probe).
- [ ] Token totals for one conversation match a manual sum of its transcript.
- [ ] With 10 conversations (fake claude processes plus generated transcripts on the test stack), the dashboard meets the CPU and memory target, and an idle client (scripted, or headless browser if available) sends no requests besides /events.

### Step 6: Phase F — Hardening extras (branch h2/f-hardening)
Build in order, and skip what Phase A ruled out (record why in NOTES.md).
1. TOTP: `ccd passwd --totp` (as web) generates a secret, prints an otpauth:// URI and a terminal QR code, asks for one valid code, and stores the secret in auth.json. It prints 10 single-use recovery codes, stored as argon2id hashes. Login asks for the code after a correct password, accepts the current 30 s step ±1, and refuses a reuse in the window. Failures count toward the brute-force limits. `ccd passwd --no-totp` removes it. Implement TOTP with node:crypto. For the QR code, prefer an image package (qrencode) or a tiny pinned dependency, and say which in NOTES.md. Off by default; never enable it on the live instance.
2. Sessions page and audit log: list active sessions (created, last seen, client IP, user agent) with Revoke and "log out everywhere". Audit JSON lines go to /var/lib/ccdash-web/audit.log (0600) for login success/failure, logout, password/TOTP change, approve, deny, interrupt, close, wake, onboard, pull and token saved. Record ids and outcomes only. Rotate at 10 MB, keep 5.
3. Egress allowlist as an opt-in `compose.egress.yaml`: ccdash on an `internal: true` network, plus a proxy container (tinyproxy or squid, pinned) on both networks allowing only the Phase A hosts (Anthropic API and login, github.com, api.github.com, npm and PyPI registries, Web Push endpoints: fcm.googleapis.com, updates.push.services.mozilla.com, web.push.apple.com). HTTPS_PROXY/HTTP_PROXY are set in ccdash, and the dashboard's GitHub and Web Push calls use it. The proxy side publishes 127.0.0.1:7690 → ccdash:7690. Limitation documented: Claude can still send data to allowed hosts.
4. gVisor: skipped (owner).
5. Speed bumps: managed settings `"permissions": { "deny": ["Bash(tmux:*)"] }` (merge with Phase H's allow later); refuse to onboard a repo whose .claude/settings.json defines hooks unless "I trust this repo's hooks" is ticked.

Done when:
- [ ] With TOTP on (test stack), a correct password plus a wrong or reused code is refused; a recovery code works once.
- [ ] Revoking a session closes its open terminals within 5 s.
- [ ] The audit log records an approve and a failed login, and contains no prompt text.
- [ ] With egress on (test stack with a fake claude doing curl, then a short live switch to the override and back): `curl https://example.com` from ccd fails while Claude, git pull and a Web Push send to an allowed host still work. The live container ends on the default compose.
- [ ] gVisor: owner (not enabled).

### Step 7: Phase G — Release-ready v0.1 (branch h2/g-release)
Repo additions: README.md, LICENSE (MIT, holder: the repo owner's GitHub account name), SECURITY.md (reporting through GitHub private vulnerability reporting, plus the security model in brief), Dockerfile.local.example, .github/workflows/image.yml, tests/*.bats, tests/replay/, dashboard/test/.

CI: confirm test.yml still covers shellcheck, bats, fixture replay (fail on any state-file diff), dashboard tests and an image build without push. image.yml: on a `v*` tag, buildx linux/amd64 and linux/arm64, push to ghcr.io/<owner>/ccdash:<tag> and :latest, with CLAUDE_CODE_VERSION and S6_OVERLAY_VERSION read from .env.example. Also add a `workflow_dispatch`/PR dry-run job that builds both arches without pushing, so the workflow is tested before any tag.

compose.yaml switches to `image: ghcr.io/<owner>/ccdash:${CCDASH_VERSION}`, with a compose.build.yaml override for local builds. The live redeploy uses `-f compose.yaml -f compose.build.yaml` from now on.

README sections: 1) what it is, a screenshot (taken from the test stack with a headless browser if one is available, otherwise a placeholder with a TODO for the owner), "not affiliated with Anthropic"; 2) requirements; 3) quick start (ccdash host user, rootless Docker, sudo rule, ccdash-docker wrapper, .env, compose up, ccd passwd, ccd login, Cloudflare hostname and Access policy); 4) adding a repo (fine-grained token, Contents rw, Metadata r, never classic; what onboarding refuses); 5) what survives what (table below) and that idle conversations are flagged, never killed; 6) security model; 7) toolchains with Dockerfile.local; 8) upgrading; 9) backup and restore.

| Event | Running work | Conversation history |
|---|---|---|
| SSH drop or browser closed | Continues | Kept |
| Host logout | Continues | Kept |
| Idle for hours | Keeps waiting, flagged idle | Kept |
| compose restart, crash, host reboot | Stops | Kept; Wake resumes it |
| compose down -v | Stops | Deleted with the volumes |

Done when:
- [ ] CI fails if any fixture replay writes a different state file than expected (proved with a throwaway commit on the branch, then reverted).
- [ ] The image.yml dry-run builds both architectures in CI without pushing.
- [ ] Backup, volume delete and restore on the test stack brings back dashboard login, history files and projects.
- [ ] Fresh-VM README run, the v0.1.0 tag, the GHCR publish and the arm64 start: owner.

### Step 8: Phase H — Agent orchestration and shared memory (branch h2/h-orchestration)
H0. Check the prerequisite: find the agent-kit repo (KIT_REPO, the owner/repo of new_ai_setup, from .claude/ kit metadata, Basic Memory notes or `gh repo list`) and check whether a ref ships `agent-kit.sh ensure <path> [design] [code] --json` with exit codes 0/2/3/4/5/6. Record KIT_REPO, KIT_REF and the result in the run file. If it is missing, do H1 to H3 only (Decided 11). Never modify the agent-kit repo.

H1. Shared Basic Memory: a pinned Basic Memory installed system-wide in the image (a venv at /opt/basic-memory, never under /home/ccd), with BASIC_MEMORY_VERSION in .env.example. Data lives in /home/ccd/basic-memory (ccdash-home volume), with one project `main` as default. On first start, init-ccdash, as ccd, registers it once at user scope under the exact name `basic-memory` (syntax from Phase A) and creates project main if missing. Managed settings get `"permissions": { "allow": ["mcp__basic-memory"] }`, merged with Phase F's deny. Record the exact `mcp__basic-memory__<tool>` names in NOTES.md for the kit (R11).

H2. Start gate: `ccd-session start` and `wake` refuse to start Claude unless `claude mcp list` shows basic-memory as connected, matched as a whole word (`grep -Eiw`), never as a substring. A refused start shows "memory offline" on the card with the check's output.

H3. Done-when items that need no kit: Start and Wake refuse with "memory offline" when Basic Memory is stopped; "disconnected" is never read as connected; a Claude subagent reads and writes memory without a permission prompt (real probe).

H4 (only if H0 passed). Kit checkout: build args KIT_REPO and KIT_REF; the Dockerfile clones the ref into /opt/agent-kit, read-only at run time. Hook point after ccd-onboard's clone/pull:
```bash
packs=$(jq -r '.packs // [] | join(" ")' "$HOME/.ccdash/projects/$proj.json")
out=$(NO_COLOR=1 KIT_REPO="$KIT_REPO" TMPDIR=/tmp \
      /opt/agent-kit/agent-kit.sh ensure "$dir" $packs --json 2>"$HOME/.ccdash/kit-$proj.log")
rc=$?; result=$(tail -n1 <<<"$out")
```
(Under `set -e`, capture rc without aborting.) Exit codes: 0 shows the kit version and whether anything changed, and onboarding continues. 2 "Kit usage error" plus the log. 3 "Kit prerequisite missing". 4 "Kit marketplace failed (network?)" with retry. 5 "Plugin install or update failed" with retry. 6 "Could not write project files". Every non-zero code stops onboarding with the repo untouched past clone/pull. Design and code checkboxes on the add form are saved as `packs`; kit-core is always on; changing them on the card reruns onboarding. When ensure changes files, commit only .claude/ and CLAUDE.md as `chore: agent-kit <version>`, author `ccdash <ccdash@localhost>`, and never push. A no-op makes no commit. Pull rebases only when every local-only commit is ccdash-authored and touches only .claude/ and CLAUDE.md; otherwise it refuses. The card shows kit version, packs and memory status.

Done when (H4 items are marked "blocked: kit prerequisite" if H0 failed):
- [ ] A fresh onboarding installs the kit, commits it once, and starts Claude with basic-memory connected.
- [ ] Onboarding again with no changes leaves no diff and no new commit.
- [ ] Unticking design removes kit-design and the vendored skill on the next run.
- [ ] With Basic Memory stopped, Start and Wake refuse with "memory offline"; a status containing "disconnected" is never read as connected.
- [ ] A kit subagent can read and write memory without a permission prompt.
- [ ] After the remote gains a commit, Pull rebases the kit commit; with a hand-made local commit, Pull refuses.
- [ ] Exit codes 2 to 6, forced with fixtures, each show their message and leave the repo as it was.

### Step 9: Final review
Run the reviewer, the simplicity-reviewer and the full checks over main. Fix findings through a PR (h2/z-review) with green CI. Delete /workspace/_h2probe and the test stacks (their volumes only). Redeploy the live container from main on the default compose. Confirm Claude is still logged in and the dashboard answers /healthz.

## Limits
May:
- Push `main` directly in Step 0 only. After that, use branches h2/* with pushes, PRs, and squash-merges on all-green CI (`gh pr merge --squash --delete-branch`).
- Set branch protection on main as described, and open, close and delete its own throwaway probe PRs and branches.
- Build images locally. Recreate the live `ccdash` container through ccdash-docker with its volumes kept, after the Step 0 backup.
- Create and remove test compose projects (e.g. `ccdashtest`) with their own names, ports (7691+) and volumes, including deleting those test volumes.
- Run real Claude as ccd in the live container inside /workspace/_h2probe (create and delete it), with temporary `--settings` files for capture hooks. Keep probes short.
- Add the dependencies this doc names (web-push, a pinned proxy image, Basic Memory, qrencode or a tiny QR package), pinned to exact versions. Use Docker images for shellcheck and bats.
- Update `docs/handoff/handoff-2-owner.md` with items the run could not finish.

May not:
- Push or create tags, publish images to GHCR or anywhere else, change repo name, visibility or settings beyond branch protection, or open PRs in other repos.
- Merge with a red or pending check, use `--admin`, `--no-verify`, SKIP_REVIEW or SKIP_VERIFY, force-push main or a branch with an open PR, or commit to main after Step 0.
- Delete or overwrite the live volumes (`ccdash-home`, `ccdash-workspace`, `ccdash-web`, `ccdash-git`) or their data, or run `compose down -v` on the live project.
- Read, print or commit secrets: .env, Claude credentials, git tokens, /etc/cloudflared, auth.json contents, VAPID private keys.
- Change the live dashboard password or TOTP, run `ccd login` or `/login`, or log Claude out.
- Install host packages, change sudoers, or touch /etc/cloudflared or the host's cloudflared.
- Send pushes to real browser endpoints, or modify the agent-kit repo.
- Leave the live container on the egress override, gVisor or any non-default compose file at the end.

## Open questions (defaults apply unless the owner says otherwise)
- Kit commits and Pull: default rebase over ccdash-only kit commits (alternative: push to a ccdash/agent-kit branch and open a PR).
- Repo name stays tmux_cc_dashboard for now; renaming to ccdash and publishing are in the owner handoff.
- If live Claude loses its login during the run, the remaining real-probe checks are marked "owner" and added to the owner handoff. The run continues with the test-stack checks.
