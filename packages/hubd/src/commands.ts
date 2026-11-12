/**
 * Command channel, hub side: send one `cmd` frame to a connected machine and wait for its `cmd.result`.
 * Nothing is persisted or queued: a machine that is offline or did not advertise the command gets an immediate `not_sent_*` result,
 * a silent one `timeout` (outcome unknown; never retried here). Pending entries live in memory and are resolved `not_sent_offline`
 * when the host's link drops. The request body (`sealed` key bytes) is passed through and never logged.
 */
import { randomUUID } from "node:crypto";
import { COMMAND_TIMEOUT_MS, type CommandKind, type CommandResponse, type CommandResultCode, type LinkCmd, type LinkCmdResult, type LinkFrame, type LinkPresence } from "@wolfpack/protocol";

export interface CommandHub {
  /** Run `kind` on `hostId`. `status` is the HTTP status the route answers with. */
  run(hostId: string, req: { kind: CommandKind; args: LinkCmd["args"]; sealed?: string }): Promise<{ status: number; body: CommandResponse }>;
  /** A cmd.result frame arrived from `hostId`'s link `epoch`. */
  onResult(hostId: string, epoch: number, f: LinkCmdResult): void;
  /** The link `epoch` of `hostId` closed. */
  onDown(hostId: string, epoch: number): void;
  /** Resolve everything still pending (hub shutdown). */
  close(): void;
}

export interface CommandHubOptions {
  presence: (hostId: string) => LinkPresence;
  advertised: (hostId: string) => readonly CommandKind[];
  epoch: (hostId: string) => number | undefined;
  send: (hostId: string, f: LinkFrame) => boolean;
  /** @internal TEST-ONLY: one timeout for every kind. */
  timeoutMs?: number;
  /** Receives only hostId, kind, id, ok and code. */
  log?: (m: string) => void;
}

interface Pending {
  hostId: string;
  epoch: number;
  kind: CommandKind;
  timer: NodeJS.Timeout;
  resolve: (r: { status: number; body: CommandResponse }) => void;
}

function statusFor(code: CommandResultCode): number {
  switch (code) {
    case "not_sent_offline":
    case "not_sent_unsupported":
      return 409;
    case "timeout":
      return 504;
    default:
      return 200;
  }
}

/** Codes only the hub may produce; a worker that sends one is rewritten to `internal`. */
const HUB_ONLY: ReadonlySet<string> = new Set(["timeout", "not_sent_offline", "not_sent_unsupported"]);
const RESTART_OK_MESSAGE = "restarting; the machine will reconnect";

export function createCommandHub(o: CommandHubOptions): CommandHub {
  const pending = new Map<string, Pending>();
  const log = o.log ?? ((m: string) => console.log(m));
  const record = (hostId: string, kind: CommandKind, id: string, ok: boolean, code?: string) => log(`hubd: command host=${hostId} kind=${kind} id=${id} ok=${ok}${code ? ` code=${code}` : ""}`);
  const fail = (id: string, hostId: string, kind: CommandKind, code: CommandResultCode, message: string) => {
    record(hostId, kind, id, false, code);
    return { status: statusFor(code), body: { id, ok: false, code, message } as CommandResponse };
  };
  // workerd.restart: the machine exits right after its ack, so a dropped link (or a silent timeout, once the frame was sent) means the restart is under way.
  // Remaining gap: a timeout or link drop after workerd.restart was sent reads as "restarting" even if the machine never restarts
  // (an ack lost before the exit, or a workerd that stays up). The hub cannot tell these apart; the machine reappearing in hello is the proof.
  // The same holds for an ack that was lost before the restart really happened: it is reported ok too.
  const restartOk = (id: string, hostId: string, kind: CommandKind) => {
    record(hostId, kind, id, true);
    return { status: 200, body: { id, ok: true, message: RESTART_OK_MESSAGE } as CommandResponse };
  };
  const settle = (id: string, r: { status: number; body: CommandResponse }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(r);
  };

  return {
    run(hostId, req) {
      const id = `c-${randomUUID()}`;
      if (o.presence(hostId) !== "online" || o.epoch(hostId) === undefined) return Promise.resolve(fail(id, hostId, req.kind, "not_sent_offline", "the machine is not connected; nothing was sent"));
      if (!o.advertised(hostId).includes(req.kind)) return Promise.resolve(fail(id, hostId, req.kind, "not_sent_unsupported", "the machine does not support this command (update its workerd); nothing was sent"));
      const epoch = o.epoch(hostId)!;
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(id, req.kind === "workerd.restart" ? restartOk(id, hostId, req.kind) : fail(id, hostId, req.kind, "timeout", "no answer in time; the outcome is unknown")), o.timeoutMs ?? COMMAND_TIMEOUT_MS[req.kind]);
        pending.set(id, { hostId, epoch, kind: req.kind, timer, resolve });
        const frame: LinkCmd = { t: "cmd", id, kind: req.kind, args: req.args, ...(req.sealed !== undefined ? { sealed: req.sealed } : {}) };
        if (!o.send(hostId, frame)) settle(id, fail(id, hostId, req.kind, "not_sent_offline", "the machine is not connected; nothing was sent"));
      });
    },
    onResult(hostId, epoch, f) {
      const p = pending.get(f.id);
      if (!p || p.hostId !== hostId || p.epoch !== epoch) return; // unknown, late or foreign: ignore
      record(hostId, p.kind, f.id, f.ok, f.code);
      const code = f.code && HUB_ONLY.has(f.code) ? "internal" : f.code;
      settle(f.id, { status: 200, body: { id: f.id, ok: f.ok, ...(code ? { code } : {}), ...(f.message ? { message: f.message } : {}), ...(f.data !== undefined ? { data: f.data } : {}) } });
    },
    onDown(hostId, epoch) {
      for (const [id, p] of [...pending]) if (p.hostId === hostId && p.epoch === epoch) settle(id, p.kind === "workerd.restart" ? restartOk(id, hostId, p.kind) : fail(id, hostId, p.kind, "not_sent_offline", "the connection to the machine dropped; the command may not have run"));
    },
    close() {
      for (const [id, p] of [...pending]) settle(id, fail(id, p.hostId, p.kind, "not_sent_offline", "the hub is shutting down"));
    },
  };
}
