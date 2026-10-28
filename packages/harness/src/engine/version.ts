import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Replaced at build time by `buildHarnessBundle` (esbuild define) with the pi-durable version the bundle contains. */
declare const __PI_DURABLE_VERSION__: string | undefined;

/** Read @earendil-works/pi-durable's version by walking up from its resolved entry, resolving from `from` (a file path or URL). */
export function readPiDurableVersion(from: string): string {
  const require = createRequire(from);
  let dir = dirname(require.resolve("@earendil-works/pi-durable"));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name === "@earendil-works/pi-durable") return String(pkg.version);
    } catch {
      /* keep walking up */
    }
    dir = dirname(dir);
  }
  return "unknown";
}

/**
 * Installed @earendil-works/pi-durable version (not exported by the package). In the CJS harness bundle
 * `import.meta.url` is undefined and pi-durable is not on disk, so the version is baked in at build time.
 */
export function engineVersion(): string {
  if (typeof __PI_DURABLE_VERSION__ === "string") return __PI_DURABLE_VERSION__;
  try {
    const here = import.meta.url ?? (typeof __filename === "string" ? __filename : undefined);
    return here ? readPiDurableVersion(here) : "unknown";
  } catch {
    return "unknown";
  }
}
