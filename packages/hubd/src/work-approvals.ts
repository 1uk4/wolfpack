/**
 * Owner-approval requests (work-wolfpack-j3QOIOu). An agent can never graduate, archive or reassign a work item on its own:
 * a worker token files a request here, and only a non-worker (owner/operator device) token approves or rejects it.
 *
 * PERSISTENCE: one JSON file, `<dataDir>/link/work-approvals.json`, rewritten atomically (temp + rename) on every change. All
 * mutations run inside the work write queue (`writeWork`), so they are ordered against every other work write and survive a restart.
 * A store whose work dir is not writable refuses the change first (the same probe every work write uses: 503 work store read-only).
 *
 * APPROVE (inside the queue): (a) the audit line is appended to the item's Record (before any stage change: an archived item closes
 * its Record), (b) the action runs: graduate delivers the STORED preview set to the hub's contribution lane, then marks the item
 * graduated (graduateItem takes no set: it only marks the ledger); archive sets stage archived; reassign assigns with the feature
 * cascade to every open child task, (c) the request is marked approved. The caller emits `work-request-changed`.
 * One pending request per item. No expiry.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadWorkState } from "@wolfpack/kb/client";
import { contentHash, type KbRoots } from "@wolfpack/kb/shared";
import type { ApprovalAuditLine, ApprovalRequest, CreateApprovalRequestBody, GraduationContribution } from "@wolfpack/protocol";
import { ContributionError, storeContribution } from "./contributions.js";
import { HubError } from "./errors.js";
import { applyOps, graduateItem, probeWorkStore } from "./work-writes.js";

export const approvalsFile = (dataDir: string): string => join(dataDir, "link", "work-approvals.json");

export interface ApprovalDeps {
  roots: KbRoots;
  dataDir: string;
  /** Librarian inbox root the stored graduation set is delivered into (as for POST /v1/contributions). */
  inboxRoot?: string;
  now?: () => Date;
  /** Is this an active wolf the hub knows (reassign target)? */
  knownWolf: (name: string) => boolean;
}

export interface Decider {
  /** The deciding actor (operator id) and the device (token id). */
  actor: string;
  device: string;
}

export function createApprovalStore(d: ApprovalDeps) {
  const file = approvalsFile(d.dataDir);
  const now = d.now ?? (() => new Date());
  const load = (): ApprovalRequest[] => {
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { requests?: ApprovalRequest[] };
    return parsed.requests ?? [];
  };
  const save = (requests: ApprovalRequest[]): void => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify({ requests }, null, 1), { mode: 0o600 });
    renameSync(tmp, file);
  };
  const itemOf = (id: string) => {
    const item = loadWorkState(d.roots).get(id as never);
    if (!item) throw new HubError("not_found", `Work item not found: ${id}`);
    return item;
  };

  const store = {
    list(q: { status?: string; workId?: string } = {}): ApprovalRequest[] {
      return load().filter((r) => (q.status === undefined || r.status === q.status) && (q.workId === undefined || r.workId === q.workId));
    },
    get(rid: string): ApprovalRequest {
      const r = load().find((x) => x.id === rid);
      if (!r) throw new HubError("not_found", `approval request not found: ${rid}`);
      return r;
    },
    /** Inside the write queue. */
    create(workId: string, body: CreateApprovalRequestBody, requestedBy: { wolf: string; thread?: string }): ApprovalRequest {
      const item = itemOf(workId);
      const all = load();
      const pending = all.find((r) => r.workId === workId && r.status === "pending");
      if (pending) throw new HubError("request_pending", `work item ${workId} already has a pending approval request (${pending.id})`, { requestId: pending.id });
      if (body.kind === "graduate" && !body.preview) throw new HubError("invalid_request", "a graduate request needs the preview (the distilled contribution set)");
      if (body.kind === "reassign") {
        if (!body.target) throw new HubError("invalid_request", "a reassign request needs a target wolf");
        if (!d.knownWolf(body.target)) throw new HubError("invalid_request", `unknown assignee ${JSON.stringify(body.target).slice(0, 80)}: not an active wolf known to this hub`);
      }
      if (body.kind === "graduate" && item.graduated) throw new HubError("invalid_request", `${workId} is already graduated`);
      if (body.kind === "archive" && item.stage === "archived") throw new HubError("invalid_request", `${workId} is already archived`);
      probeWorkStore(d.roots, String(item.domain));
      const req: ApprovalRequest = {
        id: `req-${randomBytes(4).toString("hex")}`,
        workId,
        kind: body.kind,
        requestedBy: { wolf: requestedBy.wolf, ...(requestedBy.thread ? { thread: requestedBy.thread } : {}) },
        requestedAt: now().toISOString(),
        preview: body.kind === "graduate" ? (body.preview ?? null) : null,
        target: body.kind === "reassign" ? (body.target ?? null) : null,
        status: "pending",
      };
      save([...all, req]);
      return req;
    },
    /** Inside the write queue. Returns the approved request. */
    approve(rid: string, by: Decider): ApprovalRequest {
      const all = load();
      const req = all.find((r) => r.id === rid);
      if (!req) throw new HubError("not_found", `approval request not found: ${rid}`);
      if (req.status !== "pending") throw new HubError("invalid_request", `request ${rid} is already ${req.status}`);
      const item = itemOf(req.workId);
      probeWorkStore(d.roots, String(item.domain));
      const at = now().toISOString();
      const contributions: GraduationContribution[] = req.kind === "graduate" ? (req.preview?.contributions ?? []) : [];
      // Graduating archives the item and every descendant not archived yet (the retired direct path did the same). Deepest first, so a parent never archives before its children.
      const toArchive = req.kind === "graduate" ? archiveOrder(d.roots, req.workId) : [];
      const outcome = req.kind === "graduate" ? `sent: ${contributions.length} contributions, archived ${toArchive.length}` : req.kind === "archive" ? "stage archived" : `assignee ${req.target}`;
      const audit: ApprovalAuditLine = { requestId: rid, kind: req.kind, actor: by.actor, device: by.device, at, outcome };
      // (a) The audit line, BEFORE the action: archiving closes the Record.
      applyOps(d.roots, req.workId, [{
        op: "recordAppend",
        lines: [{ at, src: "approval", kind: "decision", text: `Approved by ${audit.actor} on device ${audit.device} at ${at}: ${req.kind} (${rid}), ${outcome}`, ids: [rid] }],
      }]);
      // (b) The action.
      if (req.kind === "graduate") {
        deliverContributions(d, req, item as { domain: unknown }, contributions, at);
        graduateItem(d.roots, req.workId);
        for (const id of toArchive) {
          try {
            applyOps(d.roots, id, [{ op: "stage", to: "archived" }]);
          } catch (e) {
            // A descendant that refuses (guard error) is skipped; the rest, and the item, still archive.
            if (id === req.workId) throw e;
            console.warn(`[work-approvals] ${rid}: could not archive ${id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } else if (req.kind === "archive") {
        applyOps(d.roots, req.workId, [{ op: "stage", to: "archived" }]);
      } else {
        if (!d.knownWolf(req.target!)) throw new HubError("invalid_request", `unknown assignee ${JSON.stringify(req.target).slice(0, 80)}: not an active wolf known to this hub`);
        applyOps(d.roots, req.workId, [{ op: "assign", to: req.target! }]);
      }
      // (c) Mark it.
      const done: ApprovalRequest = { ...req, status: "approved", decidedAt: at, decidedBy: { device: by.device, actor: by.actor } };
      save(all.map((r) => (r.id === rid ? done : r)));
      return done;
    },
    /** Inside the write queue. */
    reject(rid: string, by: Decider): ApprovalRequest {
      const all = load();
      const req = all.find((r) => r.id === rid);
      if (!req) throw new HubError("not_found", `approval request not found: ${rid}`);
      if (req.status !== "pending") throw new HubError("invalid_request", `request ${rid} is already ${req.status}`);
      probeWorkStore(d.roots, String(itemOf(req.workId).domain));
      const done: ApprovalRequest = { ...req, status: "rejected", decidedAt: now().toISOString(), decidedBy: { device: by.device, actor: by.actor } };
      save(all.map((r) => (r.id === rid ? done : r)));
      return done;
    },
  };
  return store;
}

/** The item and its not-yet-archived descendants, children before parents (post-order). */
function archiveOrder(roots: KbRoots, rootId: string): string[] {
  const items = [...loadWorkState(roots).values()] as Array<{ id: unknown; partOf?: unknown; stage?: unknown }>;
  const childrenOf = new Map<string, string[]>();
  for (const c of items) if (c.partOf) childrenOf.set(String(c.partOf), [...(childrenOf.get(String(c.partOf)) ?? []), String(c.id)]);
  const stageOf = new Map(items.map((i) => [String(i.id), i.stage]));
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const c of childrenOf.get(id) ?? []) walk(c);
    if (stageOf.get(id) !== "archived") out.push(id);
  };
  walk(rootId);
  return out;
}

/** The stored preview set goes to the hub's contribution lane under the requesting wolf (the lane its own confirm would have used). */
function deliverContributions(d: ApprovalDeps, req: ApprovalRequest, item: { domain: unknown }, contributions: GraduationContribution[], at: string): void {
  const submitted = at.slice(0, 16).replace("T", " ");
  for (const c of contributions) {
    const json = {
      from: req.requestedBy.wolf,
      denTopicId: c.id,
      change: c.target ? "merge" : "create",
      contentHash: contentHash(c.body),
      prevHash: null,
      domainHint: String(item.domain),
      summary: c.summary,
      submitted,
      body: c.body,
    };
    try {
      storeContribution(d.dataDir, { id: "owner", kind: "operator" }, { json, text: JSON.stringify(json) } as never, d.inboxRoot);
    } catch (e) {
      if (e instanceof ContributionError) throw new HubError(e.code, e.message, e.details);
      throw e;
    }
  }
}
