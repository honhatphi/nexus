FROM node:22-alpine AS builder

WORKDIR /app

# ── Build common-tools first ─────────────────────────────
COPY nexus-hub/common-tools/package*.json nexus-hub/common-tools/tsconfig.json ./nexus-hub/common-tools/
RUN cd nexus-hub/common-tools && npm ci
COPY nexus-hub/common-tools/src ./nexus-hub/common-tools/src
RUN cd nexus-hub/common-tools && npm run build

# ── Build MCP server ─────────────────────────────────────
COPY mcp-server/package*.json mcp-server/tsconfig.json ./mcp-server/
RUN cd mcp-server && npm ci
COPY mcp-server/src ./mcp-server/src
RUN cd mcp-server && npm run build

# ── Production image ──────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

COPY nexus-hub/common-tools/package*.json ./nexus-hub/common-tools/
RUN cd nexus-hub/common-tools && npm ci --omit=dev

COPY mcp-server/package*.json ./mcp-server/
RUN cd mcp-server && npm ci --omit=dev

COPY --from=builder /app/nexus-hub/common-tools/dist ./nexus-hub/common-tools/dist
COPY --from=builder /app/mcp-server/dist ./mcp-server/dist

WORKDIR /app/mcp-server

EXPOSE 3100

CMD ["node", "dist/index.js"]
