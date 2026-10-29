/**
 * POST /v1/contributions: wolves hand their promote/crawl deltas to the hub. The contribution is validated with the kb
 * `ContributionSchema`, serialised with the kb's own `renderContribution` (so the file is byte-identical to a wolf-side inbox file)
 * and re-read with the kb intake parser before it is stored; anything that fails is quarantined in the wolf's `_bad/` with a reason.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Actor } from "@wolfpack/protocol";
import { ContributionSchema, contentHash, safeSegment } from "@wolfpack/kb/shared";
import { contributionFileName, renderContribution } from "@wolfpack/kb/client";
import { parseContribution } from "@wolfpack/kb/librarian";
import { contributionsDir } from "./layout.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class ContributionError extends Error {
  constructor(readonly code: "invalid_request", message: string) {
    super(message);
  }
}

export async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ContributionError("invalid_request", "request body too large");
    chunks.push(c as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new ContributionError("invalid_request", "request body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ContributionError("invalid_request", "request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function quarantine(dataDir: string, wolf: string, raw: unknown, reason: string): void {
  try {
    const dir = join(contributionsDir(dataDir, wolf), "_bad");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.json`);
    writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
    writeFileSync(`${file}.reason.txt`, reason + "\n");
  } catch (e) {
    console.warn(`hubd: could not quarantine a contribution (${reason}): ${e instanceof Error ? e.message : e}`);
  }
}

export interface StoredContribution {
  id: string;
  wolf: string;
  duplicate: boolean;
}

/** Validate + store one contribution submitted by `actor`. Throws ContributionError (invalid_request) when rejected. */
export function storeContribution(dataDir: string, actor: Actor, raw: Record<string, unknown>): StoredContribution {
  if (actor.kind !== "wolf" && actor.kind !== "operator") throw new ContributionError("invalid_request", "contributions are submitted by a wolf or an operator");
  // Lane: a wolf's own; an operator's is the `from` it names (it may submit for any wolf).
  const named = typeof raw.from === "string" ? raw.from : undefined;
  if (actor.kind === "wolf" && named !== undefined && named !== actor.id) {
    throw new ContributionError("invalid_request", `a wolf may only submit as itself (actor ${actor.id}, from ${JSON.stringify(named)})`);
  }
  const wolf = actor.kind === "wolf" ? actor.id : named ?? "";
  try {
    safeSegment(wolf, "wolf name");
  } catch (e) {
    throw new ContributionError("invalid_request", e instanceof Error ? e.message : "bad wolf name");
  }
  const reject = (reason: string): never => {
    quarantine(dataDir, wolf, raw, reason);
    throw new ContributionError("invalid_request", `malformed contribution: ${reason}`);
  };

  const parsed = ContributionSchema.safeParse(raw);
  if (!parsed.success) return reject(parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; "));
  const c = parsed.data;
  if (c.from !== wolf) return reject(`from ${JSON.stringify(c.from)} does not match the lane ${JSON.stringify(wolf)}`);
  if (c.contentHash !== contentHash(c.body)) return reject("contentHash does not match the body");

  let name: string;
  try {
    name = contributionFileName(c.denTopicId, c.contentHash);
  } catch (e) {
    return reject(e instanceof Error ? e.message : String(e));
  }
  const dir = contributionsDir(dataDir, wolf);
  mkdirSync(dir, { recursive: true });
  // Idempotent on (topic, content hash): already pending, or already handled by the curator.
  if (existsSync(join(dir, name)) || existsSync(join(dir, "_processed", name))) return { id: name, wolf, duplicate: true };

  const tmp = join(dir, `.${name}.${randomBytes(4).toString("hex")}.tmp`); // not *.md: the intake never lists it
  try {
    writeFileSync(tmp, renderContribution(c));
    try {
      parseContribution(tmp, wolf); // what the curator's intake will do
    } catch (e) {
      rmSync(tmp, { force: true });
      return reject(`intake would reject it: ${e instanceof Error ? e.message : String(e)}`);
    }
    renameSync(tmp, join(dir, name));
  } finally {
    rmSync(tmp, { force: true });
  }
  return { id: name, wolf, duplicate: false };
}
