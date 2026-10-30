#!/usr/bin/env node
/** hubd CLI: `hubd serve` and `hubd dev`. Clients authenticate with device tokens (`hubd pair`); the optional LEGACY API key comes from env HUBD_API_KEY only (never argv, never logged). */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTokenStore, PAIRING_TTL_MS } from "./auth.js";
import { exportHub, importHub } from "./export.js";
import { normalizeConsoleUrl } from "./pair-page.js";
import { createHubServer } from "./server.js";
import { assertNotLiveMirror, assertSafeDevDataDir, defaultDevDataDir, snapshotState, takeSnapshot } from "./snapshot.js";

export interface CliArgs {
  command: "serve" | "dev" | "export" | "import" | "pair" | "tokens";
  /** pair: what the code is for. */
  kind?: "worker" | "console" | "browser";
  hostId?: string;
  /** pair: base URL the phone/browser reaches (the hub, or the console when --console-url is set on serve) for the QR code. Env HUBD_PUBLIC_URL when unset. */
  url?: string;
  /** serve/dev: the console base URL the pairing page redirects to (token in the URL fragment). Env HUBD_CONSOLE_URL when unset. */
  consoleUrl?: string;
  /** tokens: list | revoke */
  sub?: "list" | "revoke";
  /** tokens revoke: the token id. */
  tokenId?: string;
  /** export: output tar. import: input tar. */
  out?: string;
  in?: string;
  dataDir?: string;
  port: number;
  host: string;
  snapshot?: string;
  allowNetwork: boolean;
  /** One-time registry seed sources (explicit; used only while the registry file does not exist). */
  seedDomains?: string;
  seedWolves: string[];
}

export const MIN_KEY_LENGTH = 16;
/** Strict: `localhost`, `::1`/`[::1]`, or a dotted-quad 127.x.y.z with every octet <= 255. DNS names such as 127.evil.com are NOT loopback. */
export const isLoopback = (h: string): boolean => {
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  if (!/^127(\.\d{1,3}){3}$/.test(h)) return false;
  return h.split(".").every((o) => Number(o) <= 255);
};

const USAGE = `usage:
  hubd serve --data-dir <dir> [--port N] [--host 127.0.0.1] [--console-url <url>] [--seed-domains <domains.yaml>] [--seed-wolf <wolf.yaml>]...
  hubd dev --snapshot <host> [--data-dir <dir>] [--port N] [--allow-network]    pull a read-only copy of <host>, then serve it
  hubd dev --data-dir <dir> [--port N]                        re-serve an earlier snapshot (no pull)
  hubd export --data-dir <dir> --out <file.tar>               write the hub state + manifest (hub must be stopped; creates run/ in <dir> to take the locks, so <dir> must be writable)
  hubd import --data-dir <dir> --in <file.tar>                restore into a missing or empty dir
  hubd pair --kind worker|console|browser [--host-id <id>] [--url <base>] --data-dir <dir>
                                                              print a single-use pairing code (valid 10 minutes) for that kind of device (--host-id: required for worker, forbidden otherwise); the device trades it at POST /v1/pair for a token.
                                                              browser: also prints a QR code for <url>/pair?code=<code> (--url, else env HUBD_PUBLIC_URL; no QR when neither is set)
  hubd tokens list --data-dir <dir>                           list device tokens (never the secrets)
  hubd tokens revoke <id> --data-dir <dir>                    revoke a token; a running hubd honours it at once and closes its event streams
env: HUBD_API_KEY (optional LEGACY shared key, >= 16 chars when set; being removed)
--host other than loopback needs "dev --allow-network" (dev serves production data copies)`;

export function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest0] = argv;
  if (command !== "serve" && command !== "dev" && command !== "export" && command !== "import" && command !== "pair" && command !== "tokens") throw new Error(USAGE);
  let rest = rest0;
  let sub: CliArgs["sub"];
  let tokenId: string | undefined;
  if (command === "tokens") {
    if (rest[0] !== "list" && rest[0] !== "revoke") throw new Error(`tokens needs list or revoke\n${USAGE}`);
    sub = rest[0];
    rest = rest.slice(1);
    if (sub === "revoke") {
      if (!rest[0] || rest[0].startsWith("--")) throw new Error("tokens revoke needs a token id");
      tokenId = rest[0];
      rest = rest.slice(1);
    }
  }
  const out: CliArgs = { command, port: 3142, host: "127.0.0.1", allowNetwork: false, seedWolves: [], ...(sub ? { sub } : {}), ...(tokenId ? { tokenId } : {}) };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    const val0 = () => {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (command === "pair" && flag === "--url") {
      out.url = val0();
      continue;
    }
    if (command === "pair" && (flag === "--kind" || flag === "--host-id")) {
      const v = val0();
      if (flag === "--kind") {
        if (v !== "worker" && v !== "console" && v !== "browser") throw new Error("--kind must be worker, console or browser");
        out.kind = v;
      } else out.hostId = v;
      continue;
    }
    if ((command === "pair" || command === "tokens") && flag !== "--data-dir") throw new Error(`${command} does not take ${flag}\n${USAGE}`);
    if ((command === "export" || command === "import") && !["--data-dir", command === "export" ? "--out" : "--in"].includes(flag)) throw new Error(`${command} does not take ${flag}\n${USAGE}`);
    const val = () => {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--data-dir") out.dataDir = val();
    else if (flag === "--seed-domains") out.seedDomains = val();
    else if (flag === "--seed-wolf") out.seedWolves.push(val());
    else if (flag === "--out" && command === "export") out.out = val();
    else if (flag === "--in" && command === "import") out.in = val();
    else if (flag === "--console-url" && (command === "serve" || command === "dev")) out.consoleUrl = normalizeConsoleUrl(val());
    else if (flag === "--host") out.host = val();
    else if (flag === "--snapshot" && command === "dev") out.snapshot = val();
    else if (flag === "--allow-network" && command === "dev") out.allowNetwork = true;
    else if (flag === "--port") {
      const raw = val();
      const p = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error("--port must be an integer from 1 to 65535");
      out.port = p;
    } else throw new Error(`unknown argument ${flag}\n${USAGE}`);
  }
  if (command === "export" && (!out.dataDir || !out.out)) throw new Error("export requires --data-dir and --out");
  if (command === "import" && (!out.dataDir || !out.in)) throw new Error("import requires --data-dir and --in");
  if (command === "pair") {
    if (!out.kind) throw new Error("pair requires --kind worker|console|browser");
    if (out.kind === "worker" && !out.hostId) throw new Error("pair --kind worker requires --host-id <id>");
    if (out.kind !== "worker" && out.hostId) throw new Error("--host-id is only for --kind worker");
  }
  if ((command === "pair" || command === "tokens") && !out.dataDir) throw new Error(`${command} requires --data-dir`);
  if (command === "serve" && !out.dataDir) throw new Error("serve requires --data-dir");
  if (command === "dev" && !out.snapshot && !out.dataDir) throw new Error("dev requires --snapshot <host> or --data-dir <existing snapshot>");
  if (command === "dev" && !isLoopback(out.host) && !out.allowNetwork) throw new Error(`refusing to bind dev mode (production data copy) to non-loopback host ${out.host} without --allow-network`);
  return out;
}

export async function main(argv: string[], env = process.env, log: (m: string) => void = console.log) {
  const args = parseArgs(argv);
  if (args.command === "export") {
    const { manifest, skipped } = exportHub({ dataDir: args.dataDir!, out: args.out! });
    log(`hubd export: ${args.out} (${manifest.files.length} files, work events ${manifest.lastEventSequence}, kb ledger lines ${manifest.kbLedgerLines})${skipped.length ? `; not exported: ${skipped.join(", ")}` : ""}`);
    return;
  }
  if (args.command === "import") {
    const manifest = importHub({ dataDir: args.dataDir!, in: args.in! });
    log(`hubd import: ${args.dataDir} (${manifest.files.length} files verified, work events ${manifest.lastEventSequence})`);
    return;
  }
  if (args.command === "pair") {
    const { code, expiresAt } = createTokenStore(args.dataDir!).mintPairingCode({ kind: args.kind!, ...(args.hostId ? { hostId: args.hostId } : {}) });
    log(`pairing code: ${code}\nfor a ${args.kind}${args.hostId ? ` token for host ${args.hostId}` : " token"}; single-use, expires ${expiresAt} (${PAIRING_TTL_MS / 60000} minutes)`);
    if (args.kind === "browser") {
      const base = (args.url ?? env.HUBD_PUBLIC_URL)?.trim().replace(/\/+$/, "");
      if (!base) log("no QR code: pass --url <hub base url> (or set HUBD_PUBLIC_URL) to print one");
      else {
        const link = `${base}/pair?code=${encodeURIComponent(code)}`;
        const { default: qr } = await import("qrcode-terminal"); // lazy: only the browser-pair path needs it
        const art = await new Promise<string>((r) => qr.generate(link, { small: true }, r));
        log(`${art}\n${link}`);
      }
    }
    return;
  }
  if (args.command === "tokens") {
    const store = createTokenStore(args.dataDir!);
    if (args.sub === "revoke") {
      if (!store.revoke(args.tokenId!)) throw new Error(`no token ${args.tokenId}`);
      log(`revoked ${args.tokenId}`);
      return;
    }
    const rows = store.list();
    if (rows.length === 0) log("no tokens");
    for (const t of rows) log(`${t.id}  ${t.kind.padEnd(7)} ${t.label}  owner=${t.owner}  created=${t.createdAt}  lastUsed=${t.lastUsedAt ?? "never"}`);
    return;
  }
  const apiKey = env.HUBD_API_KEY || undefined;
  if (apiKey !== undefined && apiKey.length < MIN_KEY_LENGTH) throw new Error(`HUBD_API_KEY must be at least ${MIN_KEY_LENGTH} characters`);
  if (apiKey) log("hubd: WARNING: HUBD_API_KEY legacy auth is enabled (temporary); prefer device tokens (hubd pair).");
  if (args.command === "dev" && !isLoopback(args.host))
    log(`!!! WARNING: dev mode is binding to ${args.host} (--allow-network). This serves a COPY OF PRODUCTION DATA to the network, protected only by the shared API key. !!!`);
  let dataDir: string;
  if (args.command === "dev") {
    dataDir = assertSafeDevDataDir(args.dataDir ?? defaultDevDataDir());
    if (args.snapshot) {
      log(`hubd dev: pulling read-only snapshot of ${args.snapshot} into ${dataDir}`);
      const m = await takeSnapshot({ host: args.snapshot, dataDir });
      log(`hubd dev: snapshot ok (${m.fileCount} files, ledger sha256 ${m.ledgerSha256.slice(0, 12)})`);
    } else {
      const state = snapshotState(dataDir);
      if (state === "none") throw new Error(`${dataDir} has no DEV-SNAPSHOT marker; refusing to treat it as a dev snapshot`);
      if (state === "incomplete") throw new Error(`${dataDir} is an INCOMPLETE snapshot (a pull did not finish); re-run \`hubd dev --snapshot <host> --data-dir ${dataDir}\` to retry, or use a fresh dir`);
    }
  } else dataDir = assertNotLiveMirror(args.dataDir!); // serve: no live mirror/den; /var/wolfpack is allowed (VPS hub)
  const hub = await createHubServer({ dataDir, apiKey, port: args.port, host: args.host, consoleUrl: args.consoleUrl ?? (env.HUBD_CONSOLE_URL?.trim() ? normalizeConsoleUrl(env.HUBD_CONSOLE_URL) : undefined), registrySeed: { domainsYaml: args.seedDomains, wolfYamls: args.seedWolves } });
  if (args.command === "dev") log("hubd dev: DEV MODE. Writes are local-only to this snapshot and are NEVER pushed back to the source host.");
  log(`hubd listening on ${hub.url} (data dir ${dataDir})`);
  const stop = () => void hub.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
