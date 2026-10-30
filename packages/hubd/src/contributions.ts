/**
 * POST /v1/contributions: wolves hand their promote/crawl deltas to the hub. The contribution is validated with the kb
 * `ContributionSchema`, serialised with the kb's own `renderContribution` (so the file is byte-identical to a wolf-side inbox file)
 * and re-read with the kb intake parser (`parseContribution`) from a temp file before it is stored. Single-line fields may not
 * contain a line break (frontmatter injection), and the re-read values must equal the submitted ones. Anything that fails is
 * quarantined in the wolf's `_bad/` (bounded: truncated raw body, deduped by its hash, capped per lane) with a reason.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Actor } from "@wolfpack/protocol";
import { ContributionSchema, contentHash, isSafeSegment, type Contribution } from "@wolfpack/kb/shared";
import { contributionFileName, renderContribution } from "@wolfpack/kb/client";
import { parseContribution } from "@wolfpack/kb/librarian";
import { contributionsRoot } from "./layout.js";

/** Largest accepted request body. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Largest raw body copy kept in `_bad/`. */
export const MAX_QUARANTINE_BYTES = 64 * 1024;
/** Most quarantined submissions kept per lane; past it a rejection is logged, not stored. */
export const MAX_BAD_PER_LANE = 500;

/** Lane (wolf) names: lowercase, start alphanumeric (never `_bad` / `_processed`), safe path segment. */
const LANE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const REASON_MAX = 300;

export class ContributionError extends Error {
  constructor(readonly code: "invalid_request", message: string) {
    super(message);
  }
}

export interface SubmittedBody {
  /** The full raw request text. */
  text: string;
  json: Record<string, unknown>;
}

/**
 * Read the request body as a JSON object. An oversize body (by Content-Length, or counted while streaming) is refused and the
 * connection closed after the response, so the rest of it is not read.
 */
export async function readJsonObject(req: IncomingMessage, res: ServerResponse): Promise<SubmittedBody> {
  const tooLarge = (): never => {
    res.setHeader("Connection", "close");
    res.once("finish", () => req.destroy());
    throw new ContributionError("invalid_request", `request body too large (max ${MAX_BODY_BYTES} bytes)`);
  };
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) tooLarge();
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ContributionError("invalid_request", "request body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ContributionError("invalid_request", "request body must be a JSON object");
  return { text, json: parsed as Record<string, unknown> };
}

/** Keep a bounded copy of a rejected submission: truncated raw body named by the sha256 of the FULL body (so a repeat is not stored twice). */
function quarantine(laneRoot: string, wolf: string, text: string, reason: string): void {
  try {
    const dir = join(laneRoot, wolf, "_bad");
    mkdirSync(dir, { recursive: true });
    const sha = createHash("sha256").update(text, "utf-8").digest("hex");
    const file = join(dir, `${sha}.raw`);
    if (existsSync(file)) return;
    if (readdirSync(dir).filter((f) => f.endsWith(".raw")).length >= MAX_BAD_PER_LANE) {
      console.warn(`hubd: ${wolf}/_bad is full (${MAX_BAD_PER_LANE}); not storing a rejected contribution (${reason.slice(0, 120)})`);
      return;
    }
    const buf = Buffer.from(text, "utf-8");
    const kept = buf.length > MAX_QUARANTINE_BYTES ? `${buf.subarray(0, MAX_QUARANTINE_BYTES).toString("utf-8")}\n[truncated: ${buf.length} bytes in total]` : text;
    writeFileSync(file, kept);
    writeFileSync(`${file}.reason.txt`, `${reason}\nsha256: ${sha}\nbytes: ${buf.length}\n`);
  } catch (e) {
    console.warn(`hubd: could not quarantine a contribution (${reason.slice(0, 120)}): ${e instanceof Error ? e.message : e}`);
  }
}

export interface StoredContribution {
  id: string;
  wolf: string;
  duplicate: boolean;
}

/** Every string below the top level except `body` (which is not frontmatter) that contains a line break. */
function lineBreakIn(c: Contribution): string | undefined {
  const walk = (v: unknown, path: string): string | undefined => {
    if (typeof v === "string") return /[\r\n]/.test(v) ? path : undefined;
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`)).find(Boolean);
    if (v && typeof v === "object") return Object.entries(v).map(([k, x]) => walk(x, `${path}.${k}`)).find(Boolean);
    return undefined;
  };
  for (const [k, v] of Object.entries(c)) if (k !== "body") { const hit = walk(v, k); if (hit) return hit; }
  return undefined;
}

const shorten = (v: unknown) => JSON.stringify(String(v)).slice(0, 60);

/** Validate + store one contribution submitted by `actor`. Throws ContributionError (invalid_request) when rejected. */
export function storeContribution(dataDir: string, actor: Actor, submitted: SubmittedBody, inboxRoot?: string): StoredContribution {
  const laneRoot = inboxRoot ?? contributionsRoot(dataDir);
  const raw = submitted.json;
  if (actor.kind !== "wolf" && actor.kind !== "operator") throw new ContributionError("invalid_request", "contributions are submitted by a wolf or an operator");
  // Lane: a wolf's own; an operator's is the `from` it names (it may submit for any wolf).
  const named = typeof raw.from === "string" ? raw.from : undefined;
  if (actor.kind === "wolf" && named !== undefined && named !== actor.id) {
    throw new ContributionError("invalid_request", `a wolf may only submit as itself (actor ${shorten(actor.id)}, from ${shorten(named)})`);
  }
  const wolf = actor.kind === "wolf" ? actor.id : named ?? "";
  if (!isSafeSegment(wolf) || !LANE_NAME.test(wolf)) {
    throw new ContributionError("invalid_request", `bad wolf name ${shorten(wolf)} (lowercase letters, digits, . _ -; must not start with _ or .)`);
  }
  const reject = (reason: string): never => {
    quarantine(laneRoot, wolf, submitted.text, reason);
    throw new ContributionError("invalid_request", `malformed contribution: ${reason}`);
  };

  const parsed = ContributionSchema.safeParse(raw);
  if (!parsed.success) return reject(parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ").slice(0, REASON_MAX));
  const c = parsed.data;
  if (c.from !== wolf) return reject(`from ${shorten(c.from)} does not match the lane ${shorten(wolf)}`);
  const lb = lineBreakIn(c);
  if (lb) return reject(`${lb} contains a line break`);
  if (c.contentHash !== contentHash(c.body)) return reject("contentHash does not match the body");

  let name: string;
  try {
    name = contributionFileName(c.denTopicId, c.contentHash);
  } catch (e) {
    return reject((e instanceof Error ? e.message : String(e)).slice(0, REASON_MAX));
  }
  const dir = join(laneRoot, wolf);
  mkdirSync(dir, { recursive: true });
  // Idempotent on (topic, content hash): already pending, or already handled by the curator.
  if (existsSync(join(dir, name)) || existsSync(join(dir, "_processed", name))) return { id: name, wolf, duplicate: true };

  const tmp = join(dir, `.${name}.${randomBytes(4).toString("hex")}.tmp`); // not *.md: the intake never lists it
  try {
    writeFileSync(tmp, renderContribution(c));
    let back;
    try {
      back = parseContribution(tmp, wolf); // what the curator's intake will do
    } catch (e) {
      return reject(`intake would reject it: ${(e instanceof Error ? e.message : String(e)).slice(0, REASON_MAX)}`);
    }
    // What intake reads must be what was submitted (a value the frontmatter cannot carry faithfully is refused, not stored altered).
    const want: Record<string, unknown> = {
      from: c.from, denTopicId: c.denTopicId, contentHash: c.contentHash, domainHint: c.domainHint, change: c.change, prevHash: c.prevHash,
      target: c.target, anchor: c.anchor, verbatim: c.verbatim && c.anchor ? true : undefined, host: c.host, session: c.session, origin: c.origin, sourcePath: c.sourcePath,
    };
    for (const [k, v] of Object.entries(want)) {
      if ((back as unknown as Record<string, unknown>)[k] !== v) return reject(`${k} does not survive the contribution file format (read back ${shorten((back as unknown as Record<string, unknown>)[k])})`);
    }
    renameSync(tmp, join(dir, name));
  } finally {
    rmSync(tmp, { force: true });
  }
  return { id: name, wolf, duplicate: false };
}
