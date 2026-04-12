FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# Install additional tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Update npm to latest major version
RUN npm install -g npm@11.12.1

# Use non-root user provided by base image
USER node
