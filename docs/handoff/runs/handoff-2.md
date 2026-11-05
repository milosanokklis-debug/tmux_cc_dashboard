# Run: docs/handoff/handoff-2.md

Started 2026-11-05 by the supervisor. The owner asked for no check-ins and allowed pushing to main (Step 0 only; PRs after that).

## Steps
| # | Step | Branch | Acceptance | Status |
|---|---|---|---|---|
| 0 | Baseline, push Handoff 1 + docs to main, volume backup, live login check, H1 TODOs | main (direct) | origin/main has H1 + docs; backups exist; Claude answers after recreate; npm test green | todo |
| 1 | Phase A: verify assumptions, CI, branch protection | h2/a-verify | Done-when boxes ticked or marked owner/synthetic; protection proven; PR merged green | todo |
| 2 | Phase B: state, liveness, wake | h2/b-state | Phase B Done-when; PR merged green | todo |
| 3 | Phase C: controls, approvals, push | h2/c-controls | Phase C Done-when; PR merged green | todo |
| 4 | Phase D: pull, git identity | h2/d-pull | Phase D Done-when; PR merged green | todo |
| 5 | Phase E: usage, tokens, optimization | h2/e-usage | Phase E Done-when; PR merged green | todo |
| 6 | Phase F: hardening extras | h2/f-hardening | Phase F Done-when; PR merged green | todo |
| 7 | Phase G: release-ready (no tag/publish) | h2/g-release | Phase G Done-when; PR merged green | todo |
| 8 | Phase H: Basic Memory + agent kit | h2/h-orchestration | Phase H Done-when (H4 may be blocked by kit prerequisite); PR merged green | todo |
| 9 | Final review, cleanup, live redeploy | h2/z-review | reviewers clean; CI green; probes and test stacks removed; live healthy | todo |

## Limits
See "Limits" in docs/handoff/handoff-2.md. In short:
- May: push main in Step 0 only; h2/* branches, PRs, squash-merge on all-green CI; set branch protection; throwaway probe PRs; local image builds; recreate the live container with volumes kept (after backup); test stacks on 7691+ with their own volumes; short real-Claude probes in /workspace/_h2probe; named pinned dependencies; Docker images for shellcheck/bats; update the owner handoff.
- May not: tags, GHCR or other publishing, repo rename or settings beyond protection; merging red/pending; --admin/--no-verify/skip gates; force-push main or open-PR branches; commits to main after Step 0; delete or overwrite the live volumes or run `down -v` on live; read or print secrets; change the live password or TOTP, log Claude in or out; host package installs, sudoers, cloudflared; pushes to real endpoints; changing the agent-kit repo; leaving live on a non-default compose.

## Decisions
- 2026-11-05: The owner told the supervisor to run without their involvement. The Handoff 1 entry gate is replaced by Step 0 (automatable H1 checks); manual checks go to docs/handoff/handoff-2-owner.md.
- 2026-11-05: Pre-flight: gh ADMIN, no protection on main; chore/agent-kit-0.9.1 is 5 ahead of main and not on origin; Claude logged in inside the live container; shellcheck/bats missing on the host (use Docker images); Basic Memory reachable (project tmux-cc-dashboard).

## Left for the owner
(see docs/handoff/handoff-2-owner.md)
