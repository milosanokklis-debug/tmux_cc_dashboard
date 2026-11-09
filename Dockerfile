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
ARG KIT_REF=18ad921ec9d8b74e295350f876bf5cf1e7f15636
ARG SEMGREP_VERSION=1.183.0
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256_AMD64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ARG GITLEAKS_SHA256_ARM64=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
ARG UV_VERSION=0.13.7
ARG UV_SHA256_AMD64=c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83
ARG UV_SHA256_ARM64=71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc

# Fixed ids so upgrades keep volume owners (web 999, ccd 1000). Created before the first package install: packages
# that add system users would otherwise take these ids first.
RUN groupadd -g 999 web \
 && groupadd -g 1000 ccd \
 && useradd -m -u 1000 -g ccd -s /bin/bash ccd \
 && useradd -r -M -u 999 -g web -G ccd -s /usr/sbin/nologin web

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

# gitleaks and uv (the kit's `attach` needs both on PATH), pinned with hard-coded sha256. Only the `uv` binary is installed:
# /usr/local/bin/uvx stays the ccdash shim.
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) gl=x64; gsha=$GITLEAKS_SHA256_AMD64; uvarch=x86_64; usha=$UV_SHA256_AMD64 ;; \
      arm64) gl=arm64; gsha=$GITLEAKS_SHA256_ARM64; uvarch=aarch64; usha=$UV_SHA256_ARM64 ;; \
      *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl -fsSL -o gitleaks.tgz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${gl}.tar.gz"; \
    echo "${gsha}  gitleaks.tgz" | sha256sum -c -; \
    tar -xzf gitleaks.tgz gitleaks; install -m 0755 gitleaks /usr/local/bin/gitleaks; \
    curl -fsSL -o uv.tgz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uvarch}-unknown-linux-gnu.tar.gz"; \
    echo "${usha}  uv.tgz" | sha256sum -c -; \
    tar -xzf uv.tgz --strip-components=1 "uv-${uvarch}-unknown-linux-gnu/uv"; install -m 0755 uv /usr/local/bin/uv; \
    rm -f gitleaks* uv*; \
    gitleaks version; uv --version

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
# no usage metrics, no version check (neither host is on the egress allowlist)
ENV SEMGREP_SEND_METRICS=off SEMGREP_ENABLE_VERSION_CHECK=0

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

RUN chmod 0750 /home/ccd \
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
