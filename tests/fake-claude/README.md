# fake-claude

A bash stub installed as `claude` in the test image (`tests/Dockerfile.fake-claude`). It prints a
`> ` prompt, reads one line at a time, and on cues runs the hooks configured in a settings file,
feeding them the fixture payloads from `tests/fixtures/2.1.317/` (session_id and cwd are rewritten
to real values; `CLAUDE_PROJECT_DIR` is set). Hooks run with `bash -c`, matched by event name and
the optional `matcher` regex (tool_name, source, notification_type, reason).

Environment: `FAKE_CLAUDE_FIXTURES` (fixtures dir), `FAKE_CLAUDE_SETTINGS` (default
`/etc/claude-code/managed-settings.json`), `FAKE_CLAUDE_TIMEOUT` (seconds per hook, default 5). The session_id is a random UUID per run (so `ccd-session wake` accepts it).
`FAKE_CLAUDE_HOME` (default `~/.fake-claude`) holds `args.log` (one line per start, the argv) and
`history/<sid>`, one line per prompt. `--resume <uuid>` prints `resumed <uuid>`, replays the old
history as `history: <prompt>` lines and carries it into the new session; a new session id is used.

Lifecycle: SessionStart on start (`source` is `resume` with `--resume`/`--continue`/`-r`/`-c`,
otherwise `startup`); every line runs UserPromptSubmit, then its cues, then Stop (unless `/fail`
or `/esc` replaces it); `/exit` (first word) or EOF runs SessionEnd and exits 0.

Cues are whitespace-separated words and match anywhere in a prompt, not only at the start. Each
prompt is read with `read -ra`, so cues are plain words, not globs.

| Cue | Effect |
|---|---|
| `/tool` | PostToolUse |
| `/perm` | PermissionRequest hooks; stdout `hookSpecificOutput.decision.behavior` allow or deny prints `permission: <x>`. No usable output prints `fall-through: asking user` and reads the next stdin line as the answer: `y`/`Y`/`yes` allows, anything else denies. The decision comes only from hook stdout. |
| `/sub` | SubagentStart then SubagentStop |
| `/fail` | StopFailure instead of Stop |
| `/notify idle\|perm` | Notification (idle_prompt or permission_prompt) |
| `/esc` | Esc interrupt: prints `interrupted` and fires no Stop, then returns to the prompt. This is hypothetical: Claude Code probably does not run Stop on a user Esc, and that is unverified until `ccd doctor --live` checks it against the real CLI. |
| `/status` | Runs `statusLine.command` from the settings with statusline.json on stdin, else prints a line derived from the fixture |

## Running the tests locally

CI (`.github/workflows/test.yml`) runs: shellcheck on every shell script, `bats tests/bats`,
`cd dashboard && npm ci && npm test`, `tests/replay-fixtures.sh`, and two `docker build`s.
Locally: `bats tests/bats && tests/replay-fixtures.sh` (needs bash, jq, bats, shellcheck).
