FROM node:22-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code slack-mcp-server
# MCP-server för Gmail + Google Kalender, installerad som verktyg i /usr/local
ENV UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN uv tool install workspace-mcp && chmod -R a+rX /opt/uv-tools /opt/uv-python
# Claude vägrar --dangerously-skip-permissions som root, så kör som node-användaren
USER node
WORKDIR /work
ENTRYPOINT ["claude"]
