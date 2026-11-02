# wolfd release tarball (H3)
    scripts/build-wolfd-release.sh [--arch x64|arm64] [--out DIR] [--with-cli]   # Docker; default x64 (DO droplet) -> dist-release/wolfd-<ver>-linux-<arch>.tar.gz
    scripts/smoke-wolfd-release.sh dist-release/wolfd-*-linux-x64.tar.gz          # clean node container, npm/npx tripwired, launch.sh, GET /v1/wolves
    wolfpack sync <wolf> --release <tarball>                                       # wolf with runtime: wolfd -> PUT /wolves/:id/bundle {runtime:"wolfd", tarball, models, env}

Contents: `packages/*/{package.json,dist}`, prod `node_modules` (harness workspace closure, glibc SDK native pkg only), `launch.sh`, `wolfd.service`
(template: @USER@ @HOME@ @RELEASE@ @MEMORY_MAX@), `templates/{wolf.yaml,models.json,.env.example}`, `tools/bin/claude` (-> the SDK's native binary),
`tools/install-claude-cli.sh` (pinned claude-code, optional), `VERSION`. Never a `.env` (the build fails if one is present).
Agent: unpacks to `<wolf home>/release` (previous kept as `release.prev`), `agent/launch.sh` execs `release/launch.sh`.
