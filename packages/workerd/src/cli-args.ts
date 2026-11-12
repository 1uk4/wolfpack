/** Argument parsing and validation for the `workerd` serve command (pure: no process.exit, testable). */
import { parseArgs } from "node:util";
import { workerdPort } from "@wolfpack/protocol/runtime-home";
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
        "key-file": { type: "string" },
        "migrate-keys": { type: "boolean" },
        "migrate-wolf-env-file": { type: "string", multiple: true },
        "migrate-env-file": { type: "string", multiple: true },
        "migrate-auth-json": { type: "string" },
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
  let port: number;
  try {
    port = values.port === undefined ? (linkOnly ? Number(env.WORKERD_PORT) : workerdPort(env)) : Number(values.port);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) return { error: `invalid --port ${values.port ?? env.WORKERD_PORT}` };
  // Explicit only: no key file means no key.set/key.remove and no Pack key presence (never a silent default location).
  const keyFile = values["key-file"] || env.WORKERD_KEY_FILE?.trim() || undefined;
  const modeRaw = env.WORKERD_KEY_FILE_MODE?.trim();
  if (modeRaw && !/^[0-7]{3,4}$/.test(modeRaw)) return { error: `invalid WORKERD_KEY_FILE_MODE ${JSON.stringify(modeRaw)} (expected octal like 600 or 640)` };
  // One-time copy of existing keys into the key file. Off unless asked for; the sources are explicit (read only, never changed).
  const migrate = values["migrate-keys"] || /^(1|true|yes|on)$/i.test(env.WORKERD_MIGRATE_KEYS ?? "");
  if (migrate && !keyFile) return { error: "--migrate-keys needs a key file: --key-file or WORKERD_KEY_FILE" };
  const list = (flag: string[] | undefined, envVal: string | undefined): string[] | undefined => {
    const all = flag?.length ? flag : (envVal ?? "").split(":").filter(Boolean);
    return all.length ? all : undefined;
  };
  const wolfEnvFiles = list(values["migrate-wolf-env-file"], env.WORKERD_MIGRATE_WOLF_ENV_FILES);
  const serviceEnvFiles = list(values["migrate-env-file"], env.WORKERD_MIGRATE_ENV_FILES);
  const authJson = values["migrate-auth-json"] || env.WORKERD_MIGRATE_AUTH_JSON?.trim() || undefined;
  return {
    opts: {
      ...(keyFile ? { keyFile } : {}),
      ...(migrate ? { keyMigration: { ...(wolfEnvFiles ? { wolfEnvFiles } : {}), ...(serviceEnvFiles ? { serviceEnvFiles } : {}), ...(authJson ? { authJson } : {}) } } : {}),
      ...(modeRaw ? { keyFileMode: parseInt(modeRaw, 8) } : {}),
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
