/**
 * The runtime-wolfd deploy body: the release tarball (scripts/build-wolfd-release.sh) as base64, plus the resolved
 * model table and env. PUT /wolves/:id/bundle {runtime:"wolfd", ...}; the agent unpacks it and runs its launch.sh.
 * The CLI never builds the release: it only ships a file built on the Mac / in Linux Docker.
 */
import fs from "node:fs";

export interface WolfdSyncBody {
  runtime: "wolfd";
  tarball: string;
  models?: string;
  env?: Record<string, string>;
}

export function buildWolfdSyncBody(tarballPath: string, extra: { modelsJson?: string; env?: Record<string, string> } = {}): WolfdSyncBody {
  if (!tarballPath) throw new Error("runtime wolfd needs a release tarball: wolfpack sync <wolf> --release <wolfd-*.tar.gz> (or WOLFD_RELEASE)");
  if (!fs.existsSync(tarballPath)) throw new Error(`release tarball not found: ${tarballPath}`);
  if (!/\.t(ar\.)?gz$/.test(tarballPath)) throw new Error(`release must be a .tar.gz: ${tarballPath}`);
  return {
    runtime: "wolfd",
    tarball: fs.readFileSync(tarballPath).toString("base64"),
    ...(extra.modelsJson ? { models: Buffer.from(extra.modelsJson).toString("base64") } : {}),
    ...(extra.env && Object.keys(extra.env).length ? { env: extra.env } : {}),
  };
}
