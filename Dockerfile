# Builder: compiles node-pty (native, no Linux prebuilds). Same base image and apt Node as the
# final stage so the ABI matches. Compilers never reach the final image.
FROM debian:trixie-slim AS dashboard-build
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs npm build-essential python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/ccdash/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci --omit=dev \
 && node -e "require('node-pty'); require('argon2'); require('ws')" \
 && rm -rf node_modules/node-pty/prebuilds node_modules/node-pty/build/Release/obj.target node_modules/node-pty/build/Release/.deps
COPY dashboard/ ./
# tests and fixtures are not needed at runtime (they stay in the build context for separate test runs)
RUN rm -rf test

FROM debian:trixie-slim
ARG TARGETARCH
ARG CLAUDE_CODE_VERSION
ARG S6_OVERLAY_VERSION
ARG BASIC_MEMORY_VERSION
ARG KIT_REPO=milosanokklis-debug/new_ai_setup
ARG KIT_REF=1099829fff8a692293f311751584983fc6821c15
ARG SEMGREP_VERSION=1.183.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tmux ncurses-term jq git curl ca-certificates procps less nodejs npm python3 python3-venv xz-utils chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# s6-overlay: noarch + arch-specific tarballs
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) s6arch=x86_64 ;; \
      arm64) s6arch=aarch64 ;; \
      *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    base=https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}; \
    for f in s6-overlay-noarch.tar.xz s6-overlay-${s6arch}.tar.xz; do \
      curl -fsSL -o /tmp/$f $base/$f; \
      curl -fsSL -o /tmp/$f.sha256 $base/$f.sha256; \
      (cd /tmp && sha256sum -c $f.sha256); \
      tar -C / -Jxpf /tmp/$f; \
    done; \
    rm -f /tmp/s6-overlay-*

# Claude Code, pinned, system-wide
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force

# Basic Memory, pinned, in its own venv (python 3.12+ needed; trixie has 3.13). Data lives in /home/ccd/basic-memory.
RUN : "${BASIC_MEMORY_VERSION:?BASIC_MEMORY_VERSION build arg is empty; pass --build-arg BASIC_MEMORY_VERSION=<version>}" \
 && python3 -m venv /opt/basic-memory \
 && /opt/basic-memory/bin/pip install --no-cache-dir "basic-memory==${BASIC_MEMORY_VERSION}" \
 && /opt/basic-memory/bin/basic-memory --help >/dev/null

# Semgrep, pinned (the kit's kit-code MCP server is `semgrep mcp`), in its own venv, on PATH
RUN : "${SEMGREP_VERSION:?SEMGREP_VERSION build arg is empty}" \
 && python3 -m venv /opt/semgrep \
 && /opt/semgrep/bin/pip install --no-cache-dir "semgrep==${SEMGREP_VERSION}" \
 && ln -s /opt/semgrep/bin/semgrep /usr/local/bin/semgrep \
 && semgrep --version >/dev/null

# Agent kit, pinned to a commit, root-owned and read-only (.git kept so the origin can be read)
RUN git clone "https://github.com/${KIT_REPO}" /opt/agent-kit \
 && git -C /opt/agent-kit checkout --detach "${KIT_REF}" \
 && chown -R root:root /opt/agent-kit && chmod -R a-w /opt/agent-kit

# The kit's npx MCP servers (pins as in the kit's plugin .mcp.json), fetched at build time so the first start does not
# depend on npm. /opt is read-only at runtime, so /usr/local/bin/npx seeds a writable cache in $HOME from this one.
RUN set -eux; \
    for p in @playwright/mcp@0.0.84 chrome-devtools-mcp@1.12.0 @upstash/context7-mcp@4.4.4 shadcn@4.23.0; do \
      npm_config_cache=/opt/npm-cache /usr/bin/npx -y -p "$p" node -e 0; \
    done; \
    rm -rf /opt/npm-cache/_logs; chmod -R a+rX /opt/npm-cache

RUN useradd -m -s /bin/bash ccd \
 && useradd -r -M -s /usr/sbin/nologin -G ccd web \
 && chmod 0750 /home/ccd \
 && install -d -o ccd -g ccd -m 0755 /workspace \
 && install -d -o web -g web -m 0700 /var/lib/ccdash-web \
 && install -d -o web -g ccd -m 2750 /var/lib/ccdash-git

COPY rootfs/ /
# payload fixtures for `ccd doctor --live` (ccd-doctor compares real hook payloads with them)
COPY tests/fixtures/2.1.317/ /usr/local/share/ccdash/fixtures/2.1.317/
RUN chmod 0755 /usr/local/bin/ccd-doctor /usr/local/bin/ccd-session /usr/local/bin/ccd-project /usr/local/bin/ccd-onboard /usr/local/bin/ccd-kit /usr/local/bin/ccd-ops /usr/local/bin/ccd-memory-init /usr/local/bin/ccd-account /usr/local/bin/uvx /usr/local/bin/npx /opt/google/chrome/chrome \
      /usr/local/lib/ccdash/git-credential-ccdash /usr/local/lib/ccdash/hooks/agents.sh /usr/local/lib/ccdash/hooks/state.sh \
      /usr/local/lib/ccdash/hooks/permission.sh /usr/local/lib/ccdash/hooks/statusline.sh /usr/local/lib/ccdash/reader.js \
      /etc/s6-overlay/s6-rc.d/init-ccdash/up \
      /etc/s6-overlay/s6-rc.d/tmux/run /etc/s6-overlay/s6-rc.d/dashboard/run /etc/s6-overlay/s6-rc.d/ccd-reader/run \
 && git config --system credential.helper /usr/local/lib/ccdash/git-credential-ccdash \
 && git config --system credential.useHttpPath true \
 && git config --system --add safe.directory /opt/agent-kit

# rootless Docker can only map IDs 0-65535, and npm ci in the builder keeps tarball owners (huge uid/gid)
COPY --from=dashboard-build --chown=0:0 /opt/ccdash/dashboard /opt/ccdash/dashboard

# Chromium for the kit's browser MCP servers: playwright-mcp via env (it never downloads a browser when the path is set)
ENV PLAYWRIGHT_MCP_EXECUTABLE_PATH=/opt/google/chrome/chrome PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DISABLE_AUTOUPDATER=1 LANG=C.UTF-8 CCDASH_TMUX=/run/ccdash/tmux.sock S6_READ_ONLY_ROOT=1
ENTRYPOINT ["/init"]
