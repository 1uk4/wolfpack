# Linux tracer image: builds the checkout, then runs hubd + workerd (non-link-only) + wolfd inside ONE container.
# Build context = repo root:  docker build -f infra/tracer/Dockerfile -t wolfpack-tracer .
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git curl procps ca-certificates util-linux && rm -rf /var/lib/apt/lists/*

# Users: hubd runs as `hubd`; workerd + the wolfd it supervises run as `wolf-hal2` (workerd spawns children as its own uid).
RUN useradd --create-home --shell /bin/bash hubd && useradd --create-home --shell /bin/bash wolf-hal2

# claude CLI, pinned (bump deliberately). Installed globally so it is on PATH for every user; `claude --version` is the build-time check.
ARG CLAUDE_CODE_VERSION=2.1.316
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && claude --version | grep -F "${CLAUDE_CODE_VERSION}"

WORKDIR /opt/wolfpack
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
# `npm ci` over the whole workspace is deliberate: it is the Linux-clean-lockfile check (git+https bridge dep included).
RUN npm ci --no-audit --no-fund
RUN npx tsc --build
COPY infra/tracer /opt/tracer
RUN chmod +x /opt/tracer/*.sh && chmod -R a+rX /opt/wolfpack /opt/tracer
ENTRYPOINT ["/opt/tracer/entrypoint.sh"]
