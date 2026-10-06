/**
 * wolfpack-librarian — the pack librarian's control surface.
 *
 * The heavy KB engine (embeddings, routing, produce, sweep) runs host-side as a
 * root systemd oneshot timer, provisioned by the wolfpack CLI only on hosts that
 * run a librarian (gated on this `kb` extension). This extension is the thin
 * in-pi control: an on-demand `/kb:sweep` that triggers the root sweep unit via
 * a narrowly-scoped NOPASSWD sudo rule. The summary is delivered over Telegram
 * by the sweep itself.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

export default function wolfpackLibrarian(pi: ExtensionAPI): void {
  pi.registerCommand("kb:sweep", {
    description: "Run the KB sweep now (drain inbox → curate entries → Telegram summary)",
    handler: async (_args: string, ctx: any) => {
      const notify = (m: string, level: "info" | "error" = "info") =>
        ctx.hasUI ? ctx.ui.notify(m, level) : console.log(m);

      const svc = `wolf-${process.env.WOLF_ID ?? ""}-kb-sweep.service`;
      notify("📚 KB sweep starting… (summary will arrive via Telegram)");

      await new Promise<void>((resolve) => {
        const proc = spawn("sudo", ["systemctl", "start", svc]);
        let err = "";
        proc.stderr.on("data", (d) => (err += d.toString()));
        proc.on("error", (e) => {
          notify(`📚 KB sweep could not start: ${e.message}`, "error");
          resolve();
        });
        proc.on("close", (code) => {
          notify(
            code === 0
              ? "📚 KB sweep complete (see Telegram for the summary)"
              : `📚 KB sweep failed (exit ${code})\n${err.trim()}`,
            code === 0 ? "info" : "error",
          );
          resolve();
        });
      });
    },
  });
}
