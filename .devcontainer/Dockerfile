FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# Install additional tools + Docker CLI (Docker-outside-of-Docker)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    socat \
    ca-certificates \
    gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# Update npm to latest major version
RUN npm install -g npm@11.12.1

# Add node user to docker group to access Docker socket (Docker-outside-of-Docker)
RUN groupadd -f docker && usermod -aG docker node

# Use non-root user provided by base image
USER node
