/**
 * Den extensions: owner-specific extensions that live in a wolf's den at
 * `<den>/extensions/<name>/` rather than in the repo.
 *
 * A source dir holds either `index.ts` (built here with esbuild on sync) or a
 * prebuilt `index.js` (shipped as is). `wolfpack sync` ships the result to the
 * host, where the harness loads `<den>/extensions/<name>/index.js`.
 */
import fs from "node:fs";
import path from "node:path";
import esbuild from "esbuild";
import { repoRoot } from "./extensions.js";

/** Never bundle what the pi runtime supplies (same set as repo extensions). */
const EXTERNAL = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "grammy"];

export type DenExtensionSource =
  | { kind: "ts"; entry: string }
  | { kind: "js"; entry: string };

/** Find `<extensionsDir>/<name>/index.ts|index.js` (ts wins), or undefined. */
export function findDenExtension(extensionsDir: string, name: string): DenExtensionSource | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return undefined;
  const ts = path.join(extensionsDir, name, "index.ts");
  if (fs.existsSync(ts)) return { kind: "ts", entry: ts };
  const js = path.join(extensionsDir, name, "index.js");
  if (fs.existsSync(js)) return { kind: "js", entry: js };
  return undefined;
}

/**
 * Produce `outFile` (a self-contained index.js) for a den extension.
 * `@wolfpack/*` imports resolve from this repo's node_modules and get bundled,
 * so the den needs no node_modules of its own.
 */
export async function buildDenExtension(src: DenExtensionSource, outFile: string): Promise<void> {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  if (src.kind === "js") {
    fs.copyFileSync(src.entry, outFile);
    return;
  }
  await esbuild.build({
    entryPoints: [src.entry],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    nodePaths: [path.join(repoRoot(), "node_modules")],
    external: EXTERNAL,
    logLevel: "silent",
  });
}
