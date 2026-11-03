@AGENTS.md

<!-- agent-kit:start -->
Before anything else, search Basic Memory (the `basic-memory` server) for this repo and task. If `basic-memory` is unavailable, stop and say so instead of continuing.
Notes for this repo live under `repos/tmux_cc_dashboard/`; notes that span repos live under `shared/`.
## Working with the agent kit
- Sessions here run as the orchestrator agent (.claude/agents/orchestrator.md): it plans and delegates; the coder and designer agents change files. Hands-on instead: `claude --agent solo`.
- New feature → /zsl:grill-me; big feature → /zsl:to-prd. Between tasks → /zsl:handoff, then /clear.
- Questions about the UI skills (which one, what it says, how it fits this code) → `claude --agent ui-guide` (read-only).
- Never install skills on your own; vet them first (`agent-kit.sh vet <owner/repo>`), suggest them and wait (find-skills is manual-only).
<!-- agent-kit:end -->
