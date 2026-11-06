# The egress allowlist proxy and port forwarder (see NOTES.md, "Phase F: egress"). Base pinned by digest
# (node:22-slim, linux index digest); no packages are installed.
FROM node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
COPY proxy.js allowlist.txt /app/
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
CMD ["node", "/app/proxy.js"]
