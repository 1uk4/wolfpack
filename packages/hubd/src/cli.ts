#!/usr/bin/env node
/** hubd CLI: `hubd serve` and `hubd dev`. Clients authenticate with device tokens (`hubd pair`); the old HUBD_API_KEY is no longer supported (serve/dev refuse to start while it is set). */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTokenStore, PAIRING_TTL_MS } from "./auth.js";
import { cleanOrphans, overLimit } from "./work-orphans.js";
import { formatReport, importWork } from "./work-import.js";
import { exportHub, importHub } from "./export.js";
import { normalizeConsoleUrl } from "./pair-page.js";
import { createHubServer } from "./server.js";
import { DEFAULT_CURATOR_POLL_MS, type CuratorOptions } from "./curator.js";
import { assertSocketPath, parseSocketMode } from "./socket.js";
import { assertNotLiveMirror, assertSafeDevDataDir, defaultDevDataDir, snapshotState, takeSnapshot } from "./snapshot.js";

export interface CliArgs {
  command: "serve" | "dev" | "export" | "import" | "pair" | "tokens" | "work-orphans" | "work-import";
  fromDomains?: string;
  fromLedger?: string;
  dryRun?: boolean;
  domainList?: string[];
  /** work-orphans: actually append the deletes (default is a dry run). */
  apply?: boolean;
  /** work-orphans: allow --apply over the safety limit. */
  force?: boolean;
  /** pair: what the code is for. */
  kind?: "worker" | "console" | "browser";
  hostId?: string;
  /** pair: device label recorded on the token (default for browser: `Browser <date>`). */
  label?: string;
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
  /** serve: listen on this unix socket instead of TCP (behind a reverse proxy). Env HUBD_SOCKET when unset. Exclusive with --port/--host. */
  socket?: string;
  /** serve: socket file mode, octal, no world bits. Default 0660. Env HUBD_SOCKET_MODE when unset. */
  socketMode?: number;
  /** True when --port or --host was given (so --socket can refuse the mix). */
  tcpExplicit?: boolean;
  snapshot?: string;
  allowNetwork: boolean;
  /** One-time registry seed sources (explicit; used only while the registry file does not exist). */
  seedDomains?: string;
  seedWolves: string[];
}

/** Strict: `localhost`, `::1`/`[::1]`, or a dotted-quad 127.x.y.z with every octet <= 255. DNS names such as 127.evil.com are NOT loopback. */
export const isLoopback = (h: string): boolean => {
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  if (!/^127(\.\d{1,3}){3}$/.test(h)) return false;
  return h.split(".").every((o) => Number(o) <= 255);
};

const USAGE = `usage:
  hubd serve --data-dir <dir> [--port N] [--host 127.0.0.1 | --socket /abs/path.sock [--socket-mode 0660]] [--console-url <url>] [--seed-domains <domains.yaml>] [--seed-wolf <wolf.yaml>]...
  hubd dev --snapshot <host> [--data-dir <dir>] [--port N] [--allow-network]    pull a read-only copy of <host>, then serve it
  hubd dev --data-dir <dir> [--port N]                        re-serve an earlier snapshot (no pull)
  hubd export --data-dir <dir> --out <file.tar>               write the hub state + manifest (hub must be stopped; creates run/ in <dir> to take the locks, so <dir> must be writable)
  hubd import --data-dir <dir> --in <file.tar>                restore into a missing or empty dir
  hubd pair --kind worker|console|browser [--host-id <id>] [--url <base>] [--label <device>] --data-dir <dir>
                                                              print a single-use pairing code (valid 10 minutes) for that kind of device (--host-id: required for worker, forbidden otherwise); the device trades it at POST /v1/pair for a token.
                                                              browser: also prints a QR code for <url>/pair?code=<code> (--url, else env HUBD_PUBLIC_URL, e.g. https://sfo-01.<tailnet>.ts.net/hub; no QR when neither is set). --label names the device in "tokens list"
  hubd work-orphans --data-dir <dir> [--apply] [--force]      list (dry run, the default) or delete, via appended work.deleted events, work items that are in the ledger as a lone work.created but have no .md.
                                                              hubd must be STOPPED even for the dry run (it takes the work-writer lock). --apply aborts unless --force when all items qualify, when a hub of <=10 items has >3, or above 10 items when more than max(3, 10%) qualify. A single genuine orphan on a 1-item hub needs --force (orphans >= total).
  hubd work-import --from-domains <dir> --from-ledger <file> --data-dir <dir> [--dry-run] [--domains personal,wolfpack]
                                                              merge the legacy work store (its domains dir and ledger, read-only) into this hub: migration duplicates collapsed, missing ledger events added (each source keeps its order, merged by time), legacy-only .md copied, newer-wins for items in both, file-only items seeded into the ledger. Backs up under <dir>/backups first. hubd must be STOPPED (work-writer lock); safe to re-run.
  hubd tokens list --data-dir <dir>                           list device tokens (never the secrets)
  hubd tokens revoke <id> --data-dir <dir>                    revoke a token; a running hubd honours it at once and closes its event streams
env: HUBD_CURATOR=1 (run the KB sweep in the hub; default off) / HUBD_CURATOR_POLL_MS (default 60000) / HUBD_CURATOR_MODELS (models.json path) / HUBD_EMBED_URL / HUBD_EMBED_MODEL
     HUBD_SOCKET / HUBD_SOCKET_MODE (serve over a unix socket instead of TCP; not together with --port/--host)
     HUBD_INBOX_ROOT / HUBD_RECEIPTS_ROOT (librarian inbox + receipts roots, e.g. /home/wolf-W1hOrJ/librarian/inbox; default <data-dir>/kb/ops/contributions and /receipts)
--host other than loopback needs "dev --allow-network" (dev serves production data copies)`;

export function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest0] = argv;
  if (command !== "serve" && command !== "dev" && command !== "export" && command !== "import" && command !== "pair" && command !== "tokens" && command !== "work-orphans" && command !== "work-import") throw new Error(USAGE);
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
    if (command === "work-import") {
      if (flag === "--dry-run") { out.dryRun = true; continue; }
      if (flag === "--from-domains") { out.fromDomains = val0(); continue; }
      if (flag === "--from-ledger") { out.fromLedger = val0(); continue; }
      if (flag === "--domains") { out.domainList = val0().split(",").map((x) => x.trim()).filter(Boolean); continue; }
    }
    if (command === "work-orphans" && flag === "--apply") { out.apply = true; continue; }
    if (command === "work-orphans" && flag === "--force") { out.force = true; continue; }
    if (command === "pair" && flag === "--label") {
      out.label = val0().slice(0, 64);
      continue;
    }
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
    else if (flag === "--socket" && command === "serve") out.socket = val();
    else if (flag === "--socket-mode" && command === "serve") out.socketMode = parseSocketMode(val());
    else if (flag === "--host") {
      out.host = val();
      out.tcpExplicit = true;
    }
    else if (flag === "--snapshot" && command === "dev") out.snapshot = val();
    else if (flag === "--allow-network" && command === "dev") out.allowNetwork = true;
    else if (flag === "--port") {
      const raw = val();
      const p = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error("--port must be an integer from 1 to 65535");
      out.port = p;
      out.tcpExplicit = true;
    } else throw new Error(`unknown argument ${flag}\n${USAGE}`);
  }
  if (command === "export" && (!out.dataDir || !out.out)) throw new Error("export requires --data-dir and --out");
  if (command === "import" && (!out.dataDir || !out.in)) throw new Error("import requires --data-dir and --in");
  if (command === "pair") {
    if (!out.kind) throw new Error("pair requires --kind worker|console|browser");
    if (out.kind === "worker" && !out.hostId) throw new Error("pair --kind worker requires --host-id <id>");
    if (out.kind !== "worker" && out.hostId) throw new Error("--host-id is only for --kind worker");
  }
  if ((command === "pair" || command === "tokens" || command === "work-orphans" || command === "work-import") && !out.dataDir) throw new Error(`${command} requires --data-dir`);
  if (command === "work-import" && (!out.fromDomains || !out.fromLedger)) throw new Error("work-import requires --from-domains and --from-ledger");
  if (command === "serve" && !out.dataDir) throw new Error("serve requires --data-dir");
  if (out.socket !== undefined) {
    if (out.tcpExplicit) throw new Error("--socket cannot be combined with --port/--host: pick TCP or a unix socket");
    assertSocketPath(out.socket);
  }
  if (out.socketMode !== undefined && out.socket === undefined) throw new Error("--socket-mode needs --socket");
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
    const label = args.label ?? (args.kind === "browser" ? `Browser ${new Date().toISOString().slice(0, 10)}` : undefined);
    const { code, expiresAt } = createTokenStore(args.dataDir!).mintPairingCode({ kind: args.kind!, ...(args.hostId ? { hostId: args.hostId } : {}), ...(label ? { label } : {}) });
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
  if (args.command === "work-import") {
    for (const l of formatReport(importWork({ fromDomains: args.fromDomains!, fromLedger: args.fromLedger!, dataDir: args.dataDir!, dryRun: !!args.dryRun, ...(args.domainList ? { domains: args.domainList } : {}) }))) log(l);
    return;
  }
  if (args.command === "work-orphans") {
    const r = cleanOrphans(args.dataDir!, { apply: !!args.apply, force: !!args.force });
    log(`${r.orphans.length} orphan(s) of ${r.total} items (limit without --force: ${r.limit}):`);
    for (const o of r.orphans) log(`orphan ${o.id}  ${o.domain}  ${o.title}`);
    for (const w of r.warnings) log(`warning: ${w}`);
    for (const k of r.skipped) log(`skipped ${k.id}: ${k.reason.replace(/[\u0000-\u001f\u007f]/g, " ")}`);
    if (r.aborted) throw new Error(r.aborted);
    log(args.apply ? `hubd work-orphans: deleted ${r.deleted.length} item(s)` : overLimit(r.orphans.length, r.total) ? "hubd work-orphans: dry run; --apply would abort without --force" : "hubd work-orphans: dry run (pass --apply to delete)");
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
  if (env.HUBD_API_KEY) throw new Error("HUBD_API_KEY is no longer supported; remove it and pair devices with `hubd pair`");
  if (args.command === "dev" && !isLoopback(args.host))
    log(`!!! WARNING: dev mode is binding to ${args.host} (--allow-network). This serves a COPY OF PRODUCTION DATA to the network, protected only by device tokens. !!!`);
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
  if (env.HUBD_CONSOLE_URL?.trim() || args.consoleUrl) {
    const cu = new URL(args.consoleUrl ?? env.HUBD_CONSOLE_URL!.trim());
    if (cu.protocol === "http:" && !isLoopback(cu.hostname)) log(`warning: the console URL ${cu.origin} is plain http on a non-loopback host; paired tokens travel to it in the clear. Use https (tailscale serve).`);
  }
  const socket = args.socket ?? (env.HUBD_SOCKET?.trim() || undefined);
  if (socket !== undefined && args.command !== "serve") throw new Error("a unix socket is only supported by serve");
  if (socket !== undefined && args.tcpExplicit) throw new Error("HUBD_SOCKET cannot be combined with --port/--host: pick TCP or a unix socket");
  const socketMode = args.socketMode ?? (env.HUBD_SOCKET_MODE?.trim() ? parseSocketMode(env.HUBD_SOCKET_MODE) : undefined);
  if (socketMode !== undefined && socket === undefined) throw new Error("HUBD_SOCKET_MODE / --socket-mode needs a unix socket (HUBD_SOCKET or --socket)");
  if (socket !== undefined) assertSocketPath(socket);
  const listen = socket !== undefined ? { socketPath: socket, ...(socketMode !== undefined ? { socketMode } : {}) } : { port: args.port, host: args.host };
  const curator = curatorFromEnv(env);
  if (curator.enabled && args.command === "dev") throw new Error("HUBD_CURATOR is not allowed in dev mode (a snapshot must never run the sweep)");
  const hub = await createHubServer({ dataDir, ...listen, curator, consoleUrl: args.consoleUrl ?? (env.HUBD_CONSOLE_URL?.trim() ? normalizeConsoleUrl(env.HUBD_CONSOLE_URL) : undefined), inboxRoot: env.HUBD_INBOX_ROOT?.trim() || undefined, receiptsRoot: env.HUBD_RECEIPTS_ROOT?.trim() || undefined, registrySeed: { domainsYaml: args.seedDomains, wolfYamls: args.seedWolves } });
  if (args.command === "dev") log("hubd dev: DEV MODE. Writes are local-only to this snapshot and are NEVER pushed back to the source host.");
  log(`hubd listening on ${hub.url} (data dir ${dataDir})`);
  const stop = () => void hub.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return hub;
}

/**
 * The hub curator's options from env (see curator.ts): HUBD_CURATOR (1/true/on; default OFF), HUBD_CURATOR_POLL_MS (default 60000,
 * 0 = no timer), HUBD_CURATOR_MODELS (path of a models.json), HUBD_EMBED_URL / HUBD_EMBED_MODEL (the embedding service; they set
 * WOLFPACK_EMBED_URL / _MODEL for this process, only when the curator is on).
 */
export function curatorFromEnv(env: NodeJS.ProcessEnv): CuratorOptions {
  const enabled = /^(1|true|on|yes)$/i.test(env.HUBD_CURATOR?.trim() ?? "");
  if (!enabled) return { enabled: false };
  const pollRaw = env.HUBD_CURATOR_POLL_MS?.trim();
  const pollMs = pollRaw ? Number(pollRaw) : DEFAULT_CURATOR_POLL_MS;
  if (!Number.isFinite(pollMs) || pollMs < 0) throw new Error(`HUBD_CURATOR_POLL_MS must be a number of milliseconds >= 0 (got ${JSON.stringify(pollRaw)})`);
  if (env.HUBD_EMBED_URL?.trim()) process.env.WOLFPACK_EMBED_URL = env.HUBD_EMBED_URL.trim();
  if (env.HUBD_EMBED_MODEL?.trim()) process.env.WOLFPACK_EMBED_MODEL = env.HUBD_EMBED_MODEL.trim();
  return { enabled, pollMs, ...(env.HUBD_CURATOR_MODELS?.trim() ? { modelsFile: env.HUBD_CURATOR_MODELS.trim() } : {}) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
