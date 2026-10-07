/**
 * wolfpack domain <verb> — manage the declared knowledge-base domains.
 *
 *   domain list                       declared domains + subscribers + entries
 *   domain add <name> [--label ..] [--description ..]
 *   domain show <name>
 *   domain rm <name>                  (guarded: must have no subscribers/entries)
 *   domain subscribe   <wolf> <name>  attach a domain to a wolf (edits wolf.yaml)
 *   domain unsubscribe <wolf> <name>
 *
 * Creation/management lives here (the "build & management of domains" arm).
 * Subscription edits the wolf's own `domains: []` — the same list surfaced in
 * `wolfpack status` and pickable at `wolfpack add wolf`.
 *
 * This arm is the ONLY writer of ~/.wolfpack/domains.yaml. Provisioning the KB
 * base folders + Syncthing mirrors happens on deploy/sync (ensureKbMirror),
 * never by hand — so `domain add` records intent and scaffolds the hub copy;
 * `wolfpack sync` / redeploy makes it live on Dewey + subscribers.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { loadConfig, getHost, localHostDir, localWolfDir, kbBaseDir } from "../config.js";
import { AgentClient } from "../agent-client.js";
import {
  loadRegistry,
  saveRegistry,
  domainExists,
  listDomainNames,
  assertValidDomainName,
  renderDomainMeta,
  registryPath,
  today,
  type DomainEntry,
} from "../domains.js";
import { deployDomainsRegistry } from "../librarian-registry.js";
import { c } from "../render.js";
import { prompt, confirm, multiSelect } from "../prompts.js";

interface DomainOpts {
  label?: string;
  description?: string;
  yes?: boolean;
}

/** Minimal wolf.yaml shape we touch here. */
interface WolfYaml {
  id: string;
  name: string;
  domains?: string[];
  extensions?: string[];
  [k: string]: unknown;
}

// ── wolf scanning (local hub) ───────────────────────────────────────────────

interface LocalWolfRef {
  name: string;
  dir: string;
  yamlPath: string;
  wolf: WolfYaml;
}

function scanLocalWolves(): LocalWolfRef[] {
  const root = localHostDir(loadConfig());
  if (!fs.existsSync(root)) return [];
  const out: LocalWolfRef[] = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const yamlPath = path.join(root, d.name, "wolf.yaml");
    if (!fs.existsSync(yamlPath)) continue;
    try {
      const wolf = yamlParse(fs.readFileSync(yamlPath, "utf8")) as WolfYaml;
      out.push({ name: wolf.name ?? d.name, dir: path.join(root, d.name), yamlPath, wolf });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/** Wolves (local hub) subscribed to a domain. */
function subscribersOf(domain: string): string[] {
  return scanLocalWolves()
    .filter((w) => (w.wolf.domains ?? []).includes(domain))
    .map((w) => w.name)
    .sort();
}

/** Count curated entries for a domain in the local KB-base mirror (best effort). */
function entryCount(domain: string): number | null {
  const dir = path.join(kbBaseDir(loadConfig()), "domains", domain, "entries");
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length;
  } catch {
    return null; // not mirrored on this host
  }
}

// ── verbs ───────────────────────────────────────────────────────────────────

export async function domainCmd(argv: string[], opts: DomainOpts): Promise<void> {
  const verb = argv[0];
  switch (verb) {
    case "list":
    case undefined:
      return domainList();
    case "add":
      return domainAdd(argv[1], opts);
    case "show":
      return domainShow(argv[1]);
    case "rm":
    case "remove":
      return domainRm(argv[1], opts);
    case "subscribe":
      // Two forms: `subscribe <wolf> <domain>` (one-off) or `subscribe <domain>`
      // (open the wolf picker to manage that domain's subscribers).
      if (argv[1] && !argv[2] && domainExists(loadRegistry(), argv[1])) {
        return manageDomainSubscribers(argv[1]);
      }
      return domainSubscribe(argv[1], argv[2], true);
    case "unsubscribe":
      return domainSubscribe(argv[1], argv[2], false);
    case "wolves":
      // Explicit alias for the picker form: `domain wolves <domain>`.
      if (!argv[1] || !domainExists(loadRegistry(), argv[1])) {
        console.error("Usage: wolfpack domain wolves <domain>");
        process.exit(1);
      }
      return manageDomainSubscribers(argv[1]);
    default:
      console.error(
        "Usage: wolfpack domain <list|add|show|rm|subscribe|unsubscribe|wolves>",
      );
      process.exit(1);
  }
}

function domainList(): void {
  const reg = loadRegistry();
  const names = listDomainNames(reg);
  if (names.length === 0) {
    console.log(c.dim("No domains declared yet. Create one: wolfpack domain add <name>"));
    return;
  }
  console.log(c.bold(`Declared domains (${names.length})`));
  for (const name of names) {
    const e = reg.domains[name]!;
    const subs = subscribersOf(name);
    const n = entryCount(name);
    const entriesLabel = n === null ? c.dim("(not mirrored here)") : `${n} entr${n === 1 ? "y" : "ies"}`;
    console.log(`  ${c.bold(name)} — ${e.label}`);
    console.log(
      `    ${c.dim(e.description || "(no description)")}`,
    );
    console.log(
      `    ${entriesLabel} · subscribers: ${subs.length ? subs.join(", ") : c.dim("none")}`,
    );
  }
}

async function domainAdd(name: string | undefined, opts: DomainOpts): Promise<void> {
  if (!name) {
    console.error("Usage: wolfpack domain add <name> [--label ..] [--description ..]");
    process.exit(1);
  }
  assertValidDomainName(name);

  const reg = loadRegistry();
  if (domainExists(reg, name)) {
    console.error(c.red(`Domain "${name}" already exists.`));
    process.exit(1);
  }

  const interactive = !opts.yes && process.stdin.isTTY;
  const label =
    opts.label ??
    (interactive ? await prompt(`Label for "${name}"`, name) : name);
  const description =
    opts.description ??
    (interactive ? await prompt(`Description`, "") : "");

  // Confirm \u2014 this writes the registry and scaffolds KB folders.
  console.log(c.bold(`\nDeclare domain "${name}"`));
  console.log(c.dim(`  label:       ${label}`));
  console.log(c.dim(`  description: ${description || "(none)"}`));
  console.log(c.dim(`  registry:    ${registryPath()}`));
  console.log(c.dim(`  scaffolds:   ${path.join(kbBaseDir(loadConfig()), "domains", name)}/`));
  if (!opts.yes && !(await confirm("Proceed?", true))) {
    console.log(c.dim("Aborted \u2014 no changes made."));
    return;
  }

  const entry: DomainEntry = { label, description, created: today() };
  reg.domains[name] = entry;
  saveRegistry(reg);

  // Scaffold the hub-side KB base folder so the domain is immediately visible
  // to `domain list` and ready to mirror. Authoritative provisioning (Dewey
  // host + Syncthing folder) happens on deploy/sync.
  scaffoldDomainFolder(name, entry);

  console.log(c.green(`✓ Declared domain "${name}"`));
  console.log(c.dim(`  Registry: ${registryPath()}`));

  // Eagerly teach the librarian the new registry so its declared-domain gate
  // recognizes this domain (best-effort; sync <librarian> also redeploys it).
  await pushRegistry();

  // Immediately offer to subscribe wolves (picker), like the extension selector.
  await offerSubscription(name, opts);
}

/** Best-effort push of domains.yaml to the librarian. */
async function pushRegistry(): Promise<void> {
  const res = await deployDomainsRegistry();
  if (res.ok) console.log(c.dim(`  \u2713 Registry pushed to librarian (${res.note})`));
  else console.log(c.dim(`  \u00b7 Registry not pushed to librarian: ${res.note}`));
}

/** Post-declare hook: offer the picker unless non-interactive. */
async function offerSubscription(domain: string, opts: DomainOpts): Promise<void> {
  if (opts.yes || !process.stdin.isTTY) {
    console.log(c.yellow(`  Next: wolfpack domain subscribe <wolf> ${domain}, then wolfpack mesh.`));
    return;
  }
  await manageDomainSubscribers(domain);
}

/**
 * Open the wolf picker for a domain (new OR existing) and apply the selection.
 * Pre-checks currently-subscribed wolves; unchecking one unsubscribes it.
 */
export async function manageDomainSubscribers(domain: string): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(c.red("A terminal is required to pick wolves. Use: wolfpack domain subscribe <wolf> " + domain));
    process.exit(1);
  }
  const wolves = await gatherSubscribable();
  if (!wolves.length) {
    console.log(c.dim("  No wolves found yet \u2014 subscribe later: wolfpack domain subscribe <wolf> " + domain));
    return;
  }
  const chosen = await multiSelect<SubscribableWolf>(
    `Subscribe wolves to "${domain}"`,
    wolves.map((w) => ({
      label: w.librarian
        ? `${w.name} ${c.dim(`(${w.host}) \u2014 librarian, owns all domains`)}`
        : `${w.name} ${c.dim(`(${w.host})`)}${w.domains.includes(domain) ? " \u2014 already" : ""}`,
      value: w,
      // The librarian is the SOURCE of every domain \u2014 always has access, never a
      // subscriber. Shown selected but locked (can't toggle).
      selected: w.librarian || w.domains.includes(domain),
      disabled: w.librarian,
    })),
  );
  // Never (un)subscribe the librarian \u2014 it owns all domains structurally.
  const togglable = wolves.filter((w) => !w.librarian);
  const toAdd = chosen.filter((w) => !w.librarian && !w.domains.includes(domain));
  const toRemove = togglable.filter((w) => w.domains.includes(domain) && !chosen.includes(w));
  for (const w of toAdd) await applySubscription(w, domain, true);
  for (const w of toRemove) await applySubscription(w, domain, false);
  if (toAdd.length || toRemove.length) {
    console.log(c.yellow("  Run `wolfpack mesh` to wire the Syncthing mirror."));
  } else {
    console.log(c.dim("  No subscription changes."));
  }
}

interface SubscribableWolf {
  name: string;
  id: string;
  host: string; // "local" | host name
  domains: string[];
  librarian: boolean;
  yamlPath?: string; // local only
}

/** All wolves across local + remote hosts, with current domains. */
async function gatherSubscribable(): Promise<SubscribableWolf[]> {
  const config = loadConfig();
  const out: SubscribableWolf[] = [];
  for (const w of scanLocalWolves()) {
    out.push({
      name: w.name,
      id: w.wolf.id,
      host: "local",
      domains: w.wolf.domains ?? [],
      librarian: (w.wolf.extensions ?? []).includes("kb"),
      yamlPath: w.yamlPath,
    });
  }
  for (const [hostName, host] of Object.entries(config.hosts)) {
    try {
      const client = new AgentClient(host);
      const { wolves } = (await client.listWolves()) as { wolves: Array<{ id: string; name: string }> };
      for (const rw of wolves) {
        let domains: string[] = [];
        let librarian = false;
        try {
          const s = (await client.wolfStatus(rw.id)) as {
            domains?: string[];
            bundle?: { extensions?: Array<{ key: string }> };
          };
          domains = s.domains ?? [];
          librarian = !!s.bundle?.extensions?.some((e) => e.key === "kb");
        } catch { /* ignore */ }
        out.push({ name: rw.name, id: rw.id, host: hostName, domains, librarian });
      }
    } catch {
      console.log(c.dim(`  (could not reach ${hostName} \u2014 its wolves skipped)`));
    }
  }
  return out;
}

/** Apply a single subscription change (local wolf.yaml or remote agent config). */
async function applySubscription(w: SubscribableWolf, domain: string, add: boolean): Promise<void> {
  const set = new Set(w.domains);
  if (add) set.add(domain); else set.delete(domain);
  const domains = [...set].sort();
  if (w.host === "local" && w.yamlPath) {
    const wolf = yamlParse(fs.readFileSync(w.yamlPath, "utf8")) as WolfYaml;
    wolf.domains = domains;
    fs.writeFileSync(w.yamlPath, yamlStringify(wolf));
  } else {
    const host = getHost(loadConfig(), w.host);
    if (!host) return;
    try {
      await new AgentClient(host).updateWolfConfig(w.id, { domains });
    } catch (err) {
      console.error(c.red(`  ! ${w.name}: ${err instanceof Error ? err.message : err}`));
      return;
    }
  }
  console.log(c.green(`  \u2713 ${w.name} ${add ? "subscribed to" : "unsubscribed from"} ${domain}`));
}

function scaffoldDomainFolder(name: string, entry: DomainEntry): void {
  const base = kbBaseDir(loadConfig());
  const domainDir = path.join(base, "domains", name);
  fs.mkdirSync(path.join(domainDir, "entries"), { recursive: true });
  // Syncthing marker: without `.stfolder` the mirror errors "folder marker
  // missing" and syncs nothing. Scaffold it now so the domain is sync-ready the
  // moment `wolfpack mesh` wires the folder (mesh also ensures this, belt-and-braces).
  fs.mkdirSync(path.join(domainDir, ".stfolder"), { recursive: true });
  const metaPath = path.join(domainDir, "meta.yaml");
  if (!fs.existsSync(metaPath)) fs.writeFileSync(metaPath, renderDomainMeta(name, entry));
  const indexPath = path.join(domainDir, "INDEX.md");
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(
      indexPath,
      `# ${entry.label} — knowledge index\n\n` +
        `${entry.description || ""}\n\n` +
        `_No entries yet. Dewey populates this on sweep._\n`,
    );
  }
  // Keep a deployed copy of the full registry at the KB base root (Dewey reads
  // it to validate classification). Not inside any domain folder → never
  // mirrored to wolves.
  const reg = loadRegistry();
  fs.writeFileSync(path.join(base, "domains.yaml"), yamlStringify(reg));
}

function domainShow(name: string | undefined): void {
  if (!name) {
    console.error("Usage: wolfpack domain show <name>");
    process.exit(1);
  }
  const reg = loadRegistry();
  if (!domainExists(reg, name)) {
    console.error(c.red(`Unknown domain: ${name}`));
    process.exit(1);
  }
  const e = reg.domains[name]!;
  const subs = subscribersOf(name);
  const n = entryCount(name);
  console.log(c.bold(`${name} — ${e.label}`));
  console.log(`  Description: ${e.description || c.dim("(none)")}`);
  console.log(`  Created:     ${e.created}`);
  console.log(`  Entries:     ${n === null ? c.dim("(not mirrored here)") : n}`);
  console.log(`  Subscribers: ${subs.length ? subs.join(", ") : c.dim("none")}`);
}

async function domainRm(name: string | undefined, opts: DomainOpts): Promise<void> {
  if (!name) {
    console.error("Usage: wolfpack domain rm <name>");
    process.exit(1);
  }
  const reg = loadRegistry();
  if (!domainExists(reg, name)) {
    console.error(c.red(`Unknown domain: ${name}`));
    process.exit(1);
  }
  const subs = subscribersOf(name);
  if (subs.length > 0) {
    console.error(
      c.red(`Refusing to remove "${name}": still subscribed by ${subs.join(", ")}.`),
    );
    console.error(c.dim("  Unsubscribe those wolves first."));
    process.exit(1);
  }
  const n = entryCount(name);
  if (n && n > 0 && !opts.yes) {
    console.error(
      c.red(`Refusing to remove "${name}": ${n} curated entr${n === 1 ? "y" : "ies"} exist.`),
    );
    console.error(c.dim("  Re-run with --yes to drop the declaration anyway (entries are left on disk)."));
    process.exit(1);
  }
  console.log(c.bold(`\nRemove domain declaration "${name}"`));
  console.log(c.dim(`  ${n ? n + " entr(y/ies) remain on disk (left for audit)" : "no entries"}`));
  if (!opts.yes && !(await confirm("Proceed?", false))) {
    console.log(c.dim("Aborted \u2014 no changes made."));
    return;
  }

  delete reg.domains[name];
  saveRegistry(reg);
  await pushRegistry();
  // Refresh the deployed registry copy; leave the KB folder on disk for audit.
  try {
    const base = kbBaseDir(loadConfig());
    if (fs.existsSync(base)) fs.writeFileSync(path.join(base, "domains.yaml"), yamlStringify(reg));
  } catch {
    /* hub not present */
  }
  console.log(c.green(`✓ Removed domain declaration "${name}"`));
  console.log(c.yellow("  Deploy/sync to drop the Syncthing mirror from subscribers."));
}

async function domainSubscribe(
  wolfName: string | undefined,
  domain: string | undefined,
  add: boolean,
): Promise<void> {
  if (!wolfName || !domain) {
    console.error(
      `Usage: wolfpack domain ${add ? "subscribe" : "unsubscribe"} <wolf> <domain>`,
    );
    process.exit(1);
  }
  const reg = loadRegistry();
  if (add && !domainExists(reg, domain)) {
    console.error(c.red(`Unknown domain: ${domain}`));
    console.error(c.dim("  Declare it first: wolfpack domain add " + domain));
    process.exit(1);
  }

  const dir = localWolfDir(loadConfig(), wolfName);
  const yamlPath = path.join(dir, "wolf.yaml");
  if (!fs.existsSync(yamlPath)) {
    console.error(c.red(`Local wolf not found: ${wolfName}`));
    console.error(c.dim("  (remote wolf subscription: edit wolf.yaml via the host, then sync)"));
    process.exit(1);
  }
  const wolf = yamlParse(fs.readFileSync(yamlPath, "utf8")) as WolfYaml;
  const set = new Set(wolf.domains ?? []);
  const already = add ? set.has(domain) : !set.has(domain);
  if (already) {
    console.log(c.dim(`${wolfName} is already ${add ? "subscribed to" : "unsubscribed from"} "${domain}" \u2014 nothing to do.`));
    return;
  }
  console.log(
    `${add ? "Subscribe" : "Unsubscribe"} ${c.bold(wolfName)} ` +
      `${add ? "to" : "from"} domain ${c.bold(domain)} (edits ${wolfName}/wolf.yaml).`,
  );
  if (!(await confirm("Proceed?", true))) {
    console.log(c.dim("Aborted \u2014 no changes made."));
    return;
  }
  if (add) set.add(domain);
  else set.delete(domain);
  wolf.domains = [...set].sort();
  fs.writeFileSync(yamlPath, yamlStringify(wolf));

  console.log(
    c.green(
      `✓ ${wolfName} ${add ? "subscribed to" : "unsubscribed from"} "${domain}"`,
    ),
  );
  console.log(
    c.dim(`  domains: ${wolf.domains.length ? wolf.domains.join(", ") : "(none)"}`),
  );
  console.log(c.yellow("  Deploy/sync to wire the mirror change."));
}
