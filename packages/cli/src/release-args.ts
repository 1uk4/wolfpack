/**
 * Argument handling for `wolfpack release` and `wolfpack release publish`.
 * Allow-list parsing: --help/-h print usage and do nothing, unknown flags are refused
 * before anything is tagged or dispatched.
 */
import type { ReleaseCmdOptions } from "./commands/release.js";

export interface ReleaseCliDeps {
  /** Dispatch release-main.yml from `ref`. */
  dispatch: (ref: string) => void;
  release: (opts: ReleaseCmdOptions) => Promise<void>;
  print: (text: string) => void;
}

const PUBLISH_USAGE = "Usage: wolfpack release publish [--ref <branch>]   (dispatches release-main.yml; default ref wolf/1uk4)";
const RELEASE_USAGE =
  "Usage: wolfpack release [component...] [--dry-run] [--minor|--major] [--version X.Y.Z] [--yes]\n       " + PUBLISH_USAGE.slice("Usage: ".length);

const isHelp = (a: string) => a === "--help" || a === "-h";

export async function runReleaseCli(a: string[], deps: ReleaseCliDeps): Promise<void> {
  if (a[0] === "publish") {
    const rest = a.slice(1);
    if (rest.some(isHelp)) return deps.print(PUBLISH_USAGE + "\n");
    let ref = "wolf/1uk4";
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--ref") {
        const v = rest[++i];
        if (!v || v.startsWith("-")) throw new Error(`--ref needs a value. ${PUBLISH_USAGE}`);
        ref = v;
      } else throw new Error(`unknown argument "${rest[i]}". ${PUBLISH_USAGE}`);
    }
    deps.dispatch(ref);
    deps.print(`dispatched release-main for ${ref}; watch it with: gh run list --workflow release-main.yml\n`);
    return;
  }
  if (a.some(isHelp)) return deps.print(RELEASE_USAGE + "\n");
  const opts: ReleaseCmdOptions = { only: [], bump: "patch", version: undefined, dryRun: false, yes: false };
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    if (x === "--major") opts.bump = "major";
    else if (x === "--minor") opts.bump = "minor";
    else if (x === "--dry-run") opts.dryRun = true;
    else if (x === "--yes" || x === "-y") opts.yes = true;
    else if (x === "--version") {
      const v = a[++i];
      if (!v || v.startsWith("-")) throw new Error(`--version needs a value. ${RELEASE_USAGE}`);
      opts.version = v;
    } else if (x.startsWith("-")) throw new Error(`unknown argument "${x}". ${RELEASE_USAGE}`);
    else opts.only.push(x);
  }
  await deps.release(opts);
}
