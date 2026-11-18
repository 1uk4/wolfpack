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
COPY extensions ./extensions
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm ci --no-audit --no-fund && npx tsc --build
# Production-only install of the wolfd closure (no devDependencies, no apps/*): same lockfile, workspace-scoped.
RUN mkdir /stage && cp package.json package-lock.json /stage/ \
 && for p in packages/*; do mkdir -p /stage/$p && cp $p/package.json /stage/$p/ && { [ ! -d $p/dist ] || cp -r $p/dist /stage/$p/; } \
 && node -e 'const fs=require("fs"),path=require("path");const [src,dst]=process.argv.slice(1);for(const f of require(path.resolve(src,"package.json")).files??[]){if(f==="dist"||f.includes("*"))continue;if(fs.existsSync(path.join(src,f)))fs.cpSync(path.join(src,f),path.join(dst,f),{recursive:true})}' $p /stage/$p; done  # runtime assets the code reads relative to dist (packages/agents/agents/*.md): everything a package lists in package.json "files"
RUN for a in apps/*; do mkdir -p /stage/$a && cp $a/package.json /stage/$a/; done \
 && cd /stage && npm ci --omit=dev --workspace=@wolfpack/harness --no-audit --no-fund \
 && rm -rf /stage/apps && rm -f /stage/package-lock.json \
 && find /stage/packages -type f \( -name '*.test.js' -o -name '*.test.d.ts' -o -name '*.test.js.map' \) -delete  # compiled tests carry fake-token fixtures and are not runtime
# glibc targets only: the musl SDK native package is another ~270 MB.
RUN rm -rf /stage/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl
# The in-process ONNX embedder (optional dep of @wolfpack/kb) is for the desktop app only; servers embed through Ollama.
RUN rm -rf /stage/node_modules/onnxruntime-node /stage/node_modules/onnxruntime-common /stage/node_modules/@huggingface/tokenizers
# claude CLI for operators / the billing probe. Default (small): tools/bin/claude -> the SDK's own native binary (same code the wolf
# runs; its version is the SDK's claudeCodeVersion), plus tools/install-claude-cli.sh to install the pinned CLI on demand.
# WITH_CLI=1 also bakes the pinned @anthropic-ai/claude-code in (+~310 MB).
ARG WITH_CLI=0
RUN A=$(case $(uname -m) in x86_64) echo x64;; aarch64) echo arm64;; esac) \
 && mkdir -p /stage/tools/bin && ln -s ../../node_modules/@anthropic-ai/claude-agent-sdk-linux-$A/claude /stage/tools/bin/claude \
 && if [ "$WITH_CLI" = 1 ]; then cd /stage/tools && npm init -y >/dev/null && npm install --no-audit --no-fund @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && ./node_modules/.bin/claude --version | grep -F "${CLAUDE_CODE_VERSION}" && rm -f package.json package-lock.json; fi
# Extension bundles, built exactly as `wolfpack sync` builds them (buildDurableExtension -> extensions/<dir>/index.js); launch.sh installs them
# into the wolf's den. Extensions without a pi-durable entry (subagents) or whose optional deps are missing are skipped. STAMP = version + content hash.
ARG RELEASE_VERSION
# KEYS = "key dir" lines from the same AVAILABLE_EXTENSIONS source `wolfpack sync` maps through; launch.sh maps wolf.yaml keys with it.
# A skip fails the build unless the extension is on ALLOW_SKIP (subagents has no pi-durable entry); skipReasons says why.
# STAMP hashes the bundle bytes only (no paths or times); the stamp comparison in launch.sh uses just that hash.
ARG ALLOW_SKIP=subagents
RUN ALLOW_SKIP="$ALLOW_SKIP" node --input-type=module -e 'const m=await import("/src/packages/cli/dist/bundle.js");const {AVAILABLE_EXTENSIONS:A}=await import("/src/packages/cli/dist/extensions.js");const fs=await import("node:fs");const allow=(process.env.ALLOW_SKIP||"").split(",").filter(Boolean);const keys=[];let bad=0;for(const e of A){const ok=await m.buildDurableExtension(e.key,"/stage/extensions");console.log("extension",e.key,ok?"bundled":"skipped");if(ok)keys.push(e.key+" "+e.dir);else if(!allow.includes(e.key)){bad++;console.error("extension",e.key,"skipped unexpectedly:",m.skipReasons.get(e.key))}}if(bad)process.exit(1);fs.writeFileSync("/stage/extensions/KEYS",keys.join("\n")+"\n")' \
 && test -f /stage/extensions/wolfpack-memory/index.js \
 && { echo "${RELEASE_VERSION} $(cd /stage/extensions && find . -type f ! -name STAMP -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)" > /stage/extensions/STAMP; }
COPY infra/release/launch.sh infra/release/wolfd.service /stage/
COPY infra/release/install-claude-cli.sh /stage/tools/
COPY infra/release/templates /stage/templates
RUN chmod +x /stage/launch.sh /stage/tools/install-claude-cli.sh && printf '%s\n' "${CLAUDE_CODE_VERSION}" > /stage/tools/CLAUDE_CODE_VERSION && echo "${RELEASE_VERSION}" > /stage/VERSION \
 && test -d /stage/node_modules/@anthropic-ai/claude-agent-sdk-linux-$(case $(uname -m) in x86_64) echo x64;; aarch64) echo arm64;; esac) \
 && mkdir /out && tar -C /stage --owner=0 --group=0 -czf /out/release.tar.gz .
