FROM node:24.22.1-bookworm-slim
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate \
    && corepack pnpm --version \
    && apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
ENV CI=true HUSKY=0 CHROME_BIN=/usr/bin/chromium
COPY verify.mjs patch.mjs common.mjs local-api.mjs smoke.mjs api-smoke.mjs security.test.mjs source-graph.mjs /automation/
WORKDIR /work
