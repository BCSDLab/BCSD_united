FROM docker.io/docker:29.6.1-cli@sha256:862099ada15c669000bef53aa4cb9d821262829f45b0dda2159ccb276443043b AS docker-cli
FROM node:24.22.1-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/koin-autofix/jobs /var/lib/koin-autofix/state /opt/autofix
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY executor.mjs executor-model.mjs verify.mjs patch.mjs common.mjs local-api.mjs smoke.mjs api-smoke.mjs security.test.mjs source-graph.mjs /opt/autofix/
ENV CI=true HUSKY=0 RUNNER_TEMP=/var/lib/koin-autofix/jobs
WORKDIR /opt/autofix
CMD ["node", "/opt/autofix/executor.mjs"]
