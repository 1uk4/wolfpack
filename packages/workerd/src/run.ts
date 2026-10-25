import { discoverWolves } from "@wolfpack/engine";
import { WorkerdServer } from "./proxy.js";
import { Supervisor, type SupervisorOptions } from "./supervisor.js";

export interface RunWorkerdOptions extends Omit<SupervisorOptions, "wolves"> {
  /** Directory holding `<wolf>/wolf.yaml`. Default: ~/wolves/local. */
  wolvesDir?: string;
  port?: number;
  host?: string;
  only?: string[];
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
    },
  };
}
