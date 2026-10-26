import { discoverWolves } from "@wolfpack/engine";
import { startSharedWorkServer, type SharedWorkServer, type StartWorkServer } from "@wolfpack/harness/sandbox";
import { WorkerdServer } from "./proxy.js";
import { Supervisor, type SupervisorOptions } from "./supervisor.js";

export interface RunWorkerdOptions extends Omit<SupervisorOptions, "wolves"> {
  /** Directory holding `<wolf>/wolf.yaml`. Default: ~/wolves/local. */
  wolvesDir?: string;
  port?: number;
  host?: string;
  only?: string[];
  /** Test seam: how the shared sandbox work server is started (default: the local work server). */
  startWorkServer?: StartWorkServer;
}

export interface RunningWorkerd {
  url: string;
  supervisor: Supervisor;
  server: WorkerdServer;
  /** Discovery problems (broken wolf.yaml files), already logged. */
  errors: string[];
  close(): Promise<void>;
}

export async function runWorkerd(opts: RunWorkerdOptions = {}): Promise<RunningWorkerd> {
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const root = opts.wolvesDir ?? `${process.env.HOME}/wolves/local`;
  const found = discoverWolves(root);
  const errors = found.errors.map((e) => e.message);
  for (const e of errors) log(`[workerd] skipping wolf: ${e}`);
  const wolves = found.wolves.map((l) => l.config).filter((w) => !opts.only?.length || opts.only.includes(w.identity.name));
  // Wolves that share a sandbox root share ONE ledger copy, so exactly one work server writes it, and it must outlive any
  // single wolf (a restarting wolf must not take the ledger down): workerd owns it, wolfd processes attach via the run file.
  const workServers: SharedWorkServer[] = [];
  for (const sandboxRoot of new Set(wolves.flatMap((w) => (w.sandbox ? [w.sandbox.root] : [])))) {
    try {
      const srv = await startSharedWorkServer(sandboxRoot, { startWorkServer: opts.startWorkServer });
      workServers.push(srv);
      log(`[workerd] sandbox ${sandboxRoot}: work server ${srv.url} (the only ledger writer)`);
    } catch (e) {
      // The wolves of this root will refuse to start with the same reason; say it once here.
      log(`[workerd] sandbox ${sandboxRoot}: no shared work server: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const supervisor = new Supervisor({ ...opts, wolves, log });
  const server = new WorkerdServer({
    registry: supervisor,
    health: () => ({ ok: true, wolves: supervisor.status() }),
  });
  const url = await server.listen(opts.port ?? 7141, opts.host);
  supervisor.start();
  return {
    url,
    supervisor,
    server,
    errors,
    async close() {
      await server.close();
      await supervisor.stop();
      for (const w of workServers) await w.close().catch(() => {});
    },
  };
}
