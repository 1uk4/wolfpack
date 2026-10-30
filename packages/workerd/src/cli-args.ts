/** Argument parsing and validation for the `workerd` serve command (pure: no process.exit, testable). */
import { parseArgs } from "node:util";
import { envLinkOnly, type RunWorkerdOptions } from "./run.js";

export type CliParse = { help: true } | { error: string } | { opts: RunWorkerdOptions };

export function parseServeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliParse {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        wolves: { type: "string", short: "w" },
        port: { type: "string", short: "p" },
        only: { type: "string", multiple: true },
        wolfd: { type: "string" },
        host: { type: "string" },
        "link-only": { type: "boolean" },
        announce: { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (values.help) return { help: true };
  const linkOnly = values["link-only"] || envLinkOnly(env);
  if (!linkOnly && values.announce?.length) return { error: "--announce needs --link-only (or WORKERD_LINK_ONLY=1)" };
  if (linkOnly && values.wolfd !== undefined) return { error: "--wolfd is not allowed with --link-only (link-only spawns nothing)" };
  if (linkOnly && values.only?.length) return { error: "--only is not allowed with --link-only (link-only supervises nothing)" };
  const port = values.port === undefined ? (linkOnly && env.WORKERD_PORT ? Number(env.WORKERD_PORT) : 7141) : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return { error: `invalid --port ${values.port ?? env.WORKERD_PORT}` };
  return {
    opts: {
      wolvesDir: values.wolves,
      port,
      host: values.host,
      linkOnly: linkOnly || undefined,
      announce: values.announce?.length ? values.announce : undefined,
      only: values.only,
      command: values.wolfd ? values.wolfd.split(/\s+/) : undefined,
    },
  };
}
