FROM node:24.22.1-bookworm-slim
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate \
    && apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
ENV CI=true HUSKY=0 CHROME_BIN=/usr/bin/chromium
WORKDIR /work
