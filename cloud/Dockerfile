# Image för Cloud Run: samma verktyg som den lokala imagen plus runner och API.
FROM node:22-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code slack-mcp-server
ENV UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN uv tool install workspace-mcp && chmod -R a+rX /opt/uv-tools /opt/uv-python

WORKDIR /app
COPY cloud/package.json ./
RUN npm install --omit=dev --no-fund --no-audit
COPY cloud/runner.mjs cloud/api.mjs ./
COPY ui/lib.mjs ./lib.mjs
COPY mcp/*.json /mcp/
RUN mkdir -p /work /data && chown node:node /work /data

# Claude vägrar --dangerously-skip-permissions som root
USER node
ENV HOME=/home/node
CMD ["node", "/app/runner.mjs"]
