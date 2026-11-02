/** Argument parsing and validation for the `workerd` serve command (pure: no process.exit, testable). */
import { parseArgs } from "node:util";
import { envLinkOnly, isLoopbackHost, type RunWorkerdOptions } from "./run.js";

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
        "wolfd-transport": { type: "string" },
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
  if (linkOnly && values.port === undefined && !env.WORKERD_PORT) return { error: "link-only needs an explicit port: --port N or WORKERD_PORT (no fallback to 7141)" };
  const wt = values["wolfd-transport"] ?? (linkOnly ? undefined : env.WORKERD_WOLFD_TRANSPORT || undefined);
  if (wt !== undefined && wt !== "socket" && wt !== "tcp") return { error: `invalid --wolfd-transport ${JSON.stringify(wt)} (expected socket or tcp)` };
  if (linkOnly && values["wolfd-transport"] !== undefined) return { error: "--wolfd-transport is not allowed with --link-only (link-only spawns nothing)" };
  const host = values.host ?? (linkOnly ? env.WORKERD_HOST || undefined : undefined);
  if (linkOnly && host && !isLoopbackHost(host)) return { error: `link-only only listens on loopback (127.0.0.1, ::1, localhost), not ${host}` };
  const port = values.port === undefined ? (linkOnly ? Number(env.WORKERD_PORT) : 7141) : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return { error: `invalid --port ${values.port ?? env.WORKERD_PORT}` };
  return {
    opts: {
      wolvesDir: values.wolves,
      port,
      host,
      linkOnly: linkOnly || undefined,
      announce: values.announce?.length ? values.announce : undefined,
      only: values.only,
      ...(wt ? { transport: wt } : {}),
      command: values.wolfd ? values.wolfd.split(/\s+/) : undefined,
    },
  };
}
