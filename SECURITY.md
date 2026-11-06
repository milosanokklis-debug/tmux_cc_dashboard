# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue.

1. Open the repository on GitHub: https://github.com/milosanokklis-debug/tmux_cc_dashboard
2. Go to the Security tab and choose Report a vulnerability.

This uses GitHub private vulnerability reporting. Only the maintainer sees the report.

## Supported versions

Only the latest release gets security fixes.

## Security model in brief

The full version is in README section 6.

- Claude and tmux run as the user `ccd`. The dashboard runs as the user `web`. `ccd` cannot read the dashboard's files.
- The container has a read-only root filesystem, dropped capabilities, `no-new-privileges`, and pid, memory and CPU limits. The port is bound to 127.0.0.1 only.
- The dashboard uses session login with argon2id password hashes, Origin and X-CCDash checks, and rate limits. Setup turns on TOTP.
- Setup also turns on an egress allowlist. Only listed hosts are reachable from the container.
- Claude can still do anything `ccd` can do. It can reach every allowed host, including GitHub with the token you gave it. Managed settings and hook checks are speed bumps, not a sandbox. The egress allowlist does not stop data from leaving to allowed hosts.
