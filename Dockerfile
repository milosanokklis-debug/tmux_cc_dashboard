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

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tmux ncurses-term jq git curl ca-certificates procps less nodejs npm python3 xz-utils \
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

RUN useradd -m -s /bin/bash ccd \
 && useradd -r -M -s /usr/sbin/nologin -G ccd web \
 && chmod 0750 /home/ccd \
 && install -d -o ccd -g ccd -m 0755 /workspace \
 && install -d -o web -g web -m 0700 /var/lib/ccdash-web \
 && install -d -o web -g ccd -m 2750 /var/lib/ccdash-git

COPY rootfs/ /
RUN chmod 0755 /usr/local/bin/ccd-session /usr/local/bin/ccd-project /usr/local/bin/ccd-onboard /usr/local/bin/ccd-ops \
      /usr/local/lib/ccdash/git-credential-ccdash /usr/local/lib/ccdash/hooks/agents.sh /usr/local/lib/ccdash/hooks/state.sh \
      /usr/local/lib/ccdash/hooks/permission.sh \
      /etc/s6-overlay/s6-rc.d/init-ccdash/up \
      /etc/s6-overlay/s6-rc.d/tmux/run /etc/s6-overlay/s6-rc.d/dashboard/run \
 && git config --system credential.helper /usr/local/lib/ccdash/git-credential-ccdash \
 && git config --system credential.useHttpPath true

COPY --from=dashboard-build /opt/ccdash/dashboard /opt/ccdash/dashboard

ENV DISABLE_AUTOUPDATER=1 LANG=C.UTF-8 CCDASH_TMUX=/run/ccdash/tmux.sock S6_READ_ONLY_ROOT=1
ENTRYPOINT ["/init"]
