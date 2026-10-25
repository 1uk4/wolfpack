import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Installed @earendil-works/pi-durable version, read from its package.json (not exported by the package). */
export function engineVersion(): string {
  const require = createRequire(import.meta.url);
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
