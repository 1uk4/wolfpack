# Per-run tracer image: ONLY the repo on top of the shared base (see Dockerfile.base). Built by run-tracer.sh from a clean `git archive` export.
#   docker build -f infra/tracer/Dockerfile --build-arg BASE=wolfpack-tracer-base:<hash> <export dir>
ARG BASE
FROM ${BASE}
WORKDIR /opt/wolfpack
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY extensions ./extensions
# `npm ci` over the whole workspace is deliberate: it is the Linux-clean-lockfile check (git+https bridge dep included). The npm cache is a BuildKit cache mount.
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
RUN npx tsc --build
COPY infra/tracer/kb-ext-entry.ts ./kb-ext-entry.ts
# --kb mode: the real memory/tasks extension sources as one ESM file (packages stay external, resolved from /opt/wolfpack/node_modules)
RUN npx esbuild kb-ext-entry.ts --bundle --platform=node --format=esm --packages=external --outfile=kb-ext.mjs --log-level=warning
COPY scripts/build-server.mjs ./scripts/build-server.mjs
# --console payload (standalone server built IN the Linux image). NEXT_PUBLIC_WOLFPACK_HUB_URL is the only build-time console value; not needed for the tracer.
RUN --mount=type=cache,target=/root/.npm node scripts/build-server.mjs --out /opt/console && du -sh /opt/console
COPY infra/tracer /opt/tracer
RUN cp /opt/tracer/console-proof.mjs /opt/proof/console-proof.mjs && chmod +x /opt/tracer/*.sh && chmod -R a+rX /opt/wolfpack /opt/tracer /opt/console /opt/proof
ENTRYPOINT ["/opt/tracer/entrypoint.sh"]
