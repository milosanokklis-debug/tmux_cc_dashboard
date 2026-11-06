#!/bin/sh
# Stack-test stand-in for /opt/agent-kit/agent-kit.sh: succeeds, changes nothing (see tests/Dockerfile.stack).
echo "inert kit (stack test)" >&2
echo '{"ok":true,"changed":false,"kit_version":"0.0.0","installed":[],"updated":[],"removed":[],"files":[],"memory":"missing"}'
