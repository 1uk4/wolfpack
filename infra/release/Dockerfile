# Release builder: runs in Linux Docker (built for the TARGET arch with --platform) so native optional deps (the Agent SDK's
# @anthropic-ai/claude-agent-sdk-linux-<arch>) resolve for the target. The droplet never builds anything.
# Context = repo root. Produces /out/wolfd-<version>-linux-<arch>.tar.gz (see scripts/build-wolfd-release.sh).
FROM node:22-bookworm AS build
ARG CLAUDE_CODE_VERSION=2.1.316
ARG RELEASE_VERSION=dev
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --no-audit --no-fund && npx tsc --build
# Production-only install of the wolfd closure (no devDependencies, no apps/*): same lockfile, workspace-scoped.
RUN mkdir /stage && cp package.json package-lock.json /stage/ \
 && for p in packages/*; do mkdir -p /stage/$p && cp $p/package.json /stage/$p/ && { [ ! -d $p/dist ] || cp -r $p/dist /stage/$p/; }; done
RUN for a in apps/*; do mkdir -p /stage/$a && cp $a/package.json /stage/$a/; done \
 && cd /stage && npm ci --omit=dev --workspace=@wolfpack/harness --no-audit --no-fund \
 && rm -rf /stage/apps && rm -f /stage/package-lock.json
# glibc targets only: the musl SDK native package is another ~270 MB.
RUN rm -rf /stage/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl
# claude CLI for operators / the billing probe. Default (small): tools/bin/claude -> the SDK's own native binary (same code the wolf
# runs; its version is the SDK's claudeCodeVersion), plus tools/install-claude-cli.sh to install the pinned CLI on demand.
# WITH_CLI=1 also bakes the pinned @anthropic-ai/claude-code in (+~310 MB).
ARG WITH_CLI=0
RUN A=$(case $(uname -m) in x86_64) echo x64;; aarch64) echo arm64;; esac) \
 && mkdir -p /stage/tools/bin && ln -s ../../node_modules/@anthropic-ai/claude-agent-sdk-linux-$A/claude /stage/tools/bin/claude \
 && if [ "$WITH_CLI" = 1 ]; then cd /stage/tools && npm init -y >/dev/null && npm install --no-audit --no-fund @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && ./node_modules/.bin/claude --version | grep -F "${CLAUDE_CODE_VERSION}" && rm -f package.json package-lock.json; fi
COPY infra/release/launch.sh infra/release/wolfd.service /stage/
COPY infra/release/install-claude-cli.sh /stage/tools/
COPY infra/release/templates /stage/templates
RUN chmod +x /stage/launch.sh /stage/tools/install-claude-cli.sh && printf '%s\n' "${CLAUDE_CODE_VERSION}" > /stage/tools/CLAUDE_CODE_VERSION && echo "${RELEASE_VERSION}" > /stage/VERSION \
 && test -d /stage/node_modules/@anthropic-ai/claude-agent-sdk-linux-$(case $(uname -m) in x86_64) echo x64;; aarch64) echo arm64;; esac) \
 && mkdir /out && tar -C /stage --owner=0 --group=0 -czf /out/release.tar.gz .
