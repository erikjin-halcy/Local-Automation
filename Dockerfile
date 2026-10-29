FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code
# Claude vägrar --dangerously-skip-permissions som root, så kör som node-användaren
USER node
WORKDIR /work
ENTRYPOINT ["claude"]
