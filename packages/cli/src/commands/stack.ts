/**
 * wolfpack stack install|start|stop|restart|status|logs [-f] [-n N]|uninstall   (the live Mac stack under launchd)
 * wolfpack stack dev [start|stop|status] [--app console|none]                  (the sandboxed dev stack)
 * Wires scripts/stack.mjs and scripts/dev-stack.mjs (which hold the behaviour and its tests) into the CLI, like `wolfpack preview`.
 * The scripts are found relative to this file (dist/commands -> repo root), so they run from the checkout this CLI was built in.
 * Returns the exit code: the script's own code (status: 0 only when healthy), or 1 after printing `stack: <msg>` for any
 * error the scripts throw (usage, launchctl, lsof), so the CLI shows no stack trace and leaves no unhandled rejection.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = (name: string): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../scripts", name);

type DevStack = { main: (argv: string[]) => number | void };
type Stack = { main: (argv: string[]) => Promise<{ code: number }> };

export async function stackCmd(argv: string[]): Promise<number> {
  try {
    if (argv[0] === "dev") {
      const mod = (await import(pathToFileURL(script("dev-stack.mjs")).href)) as DevStack;
      return (await mod.main(argv.slice(1))) ?? 0;
    }
    const mod = (await import(pathToFileURL(script("stack.mjs")).href)) as Stack;
    return (await mod.main(argv)).code;
  } catch (e) {
    console.error(`stack: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
