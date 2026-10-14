// ─── Sweep Manager ─────────────────────────────────────────────────────────
export class SweepManager {
    status = { state: "idle" };
    config;
    abortController = null;
    constructor(config) {
        this.config = config;
    }
    getStatus() {
        return { ...this.status };
    }
    isRunning() {
        return this.status.state === "running";
    }
    async start(opts) {
        if (this.isRunning()) {
            return { started: false, reason: "Sweep already running" };
        }
        const dryRun = opts?.dryRun ?? false;
        this.status = {
            state: "running",
            startedAt: new Date().toISOString(),
            progress: dryRun ? "Starting (dry run)..." : "Starting...",
        };
        this.abortController = new AbortController();
        // Run sweep asynchronously (fire-and-forget, but tracked via status)
        this.runSweep(dryRun).catch((err) => {
            this.status = {
                state: "failed",
                startedAt: this.status.startedAt,
                completedAt: new Date().toISOString(),
                error: err instanceof Error ? err.message : String(err),
            };
        });
        return { started: true };
    }
    async stop() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
            this.status = {
                state: "idle",
                progress: "Stopped by user",
            };
        }
    }
    async runSweep(dryRun = false) {
        const startTime = Date.now();
        try {
            if (dryRun) {
                // Dry run: test the machinery without processing
                this.updateProgress("[DRY RUN] Loading KB engine...");
                await new Promise(r => setTimeout(r, 500));
                this.updateProgress("[DRY RUN] Checking inbox...");
                const { drainInbox } = await import("@wolfpack/kb/librarian");
                const roots = {
                    kbBase: this.config.kbBase,
                    opsRoot: this.config.kbOps,
                    denLocal: this.config.denLocal,
                };
                const inbox = drainInbox(roots);
                await new Promise(r => setTimeout(r, 500));
                this.updateProgress(`[DRY RUN] Found ${inbox.length} items in inbox`);
                await new Promise(r => setTimeout(r, 500));
                this.updateProgress("[DRY RUN] Simulating sweep...");
                await new Promise(r => setTimeout(r, 1000));
                const duration = Date.now() - startTime;
                this.status = {
                    state: "completed",
                    startedAt: this.status.startedAt,
                    completedAt: new Date().toISOString(),
                    progress: "Dry run completed (no changes made)",
                    result: {
                        processed: 0,
                        created: 0,
                        merged: 0,
                        rejected: 0,
                        parked: 0,
                        remaining: inbox.length,
                        duration,
                    },
                };
                console.log(`[librarian] Dry run completed: ${inbox.length} items in inbox (no changes made)`);
                return;
            }
            this.updateProgress("Loading KB engine...");
            // Dynamic imports to keep startup fast
            const { createEngine } = await import("@wolfpack/engine");
            const { sweep } = await import("@wolfpack/kb/librarian");
            const roots = {
                kbBase: this.config.kbBase,
                opsRoot: this.config.kbOps,
                denLocal: this.config.denLocal,
            };
            // Set up embedder environment
            if (this.config.embedUrl) {
                process.env.WOLFPACK_EMBED_URL = this.config.embedUrl;
            }
            if (this.config.embedModel) {
                process.env.WOLFPACK_EMBED_MODEL = this.config.embedModel;
            }
            this.updateProgress("Creating engine...");
            const engine = createEngine({
                provider: this.config.provider ?? "anthropic",
                defaultModel: this.config.model ?? "claude-sonnet-4-6",
                steps: {
                    classify: { model: this.config.fastModel ?? "claude-haiku-4-5" },
                    produce: { model: this.config.model ?? "claude-sonnet-4-6" },
                },
            });
            this.updateProgress("Loading entry vectors...");
            const { readLedger, foldRegistry, createEmbedder, buildEntryVectors } = await import("@wolfpack/kb/librarian");
            const embedder = createEmbedder(roots);
            const registry = foldRegistry(readLedger(roots));
            const loadEntryVectors = () => buildEntryVectors(roots, registry, embedder);
            this.updateProgress("Running sweep...");
            const result = await sweep({
                engine,
                roots,
                loadEntryVectors,
                notify: (msg) => this.updateProgress(msg),
            });
            const duration = Date.now() - startTime;
            this.status = {
                state: "completed",
                startedAt: this.status.startedAt,
                completedAt: new Date().toISOString(),
                result: {
                    processed: result.processed,
                    created: result.created,
                    merged: result.merged,
                    rejected: result.rejected,
                    parked: result.parked.length,
                    remaining: result.remaining,
                    duration,
                },
            };
            console.log(`[librarian] Sweep completed: ${result.processed} processed, ${result.created} created, ${result.merged} merged`);
            // Post-sweep reorg: check if any touched sections need splitting
            if (result.processed > 0) {
                try {
                    this.updateProgress("Running post-sweep reorg check...");
                    const { reorg } = await import("@wolfpack/kb/librarian");
                    const reorgResult = await reorg({
                        engine,
                        roots,
                        notify: (msg) => this.updateProgress(msg),
                    });
                    if (reorgResult.splits > 0 || reorgResult.merges > 0 || reorgResult.crystallized > 0) {
                        console.log(`[librarian] Reorg: ${reorgResult.splits} splits, ${reorgResult.merges} merges, ${reorgResult.crystallized} crystallized`);
                    }
                }
                catch (reorgErr) {
                    console.error("[librarian] Post-sweep reorg failed:", reorgErr instanceof Error ? reorgErr.message : reorgErr);
                }
            }
        }
        catch (err) {
            console.error("[librarian] Sweep failed:", err instanceof Error ? err.message : err);
            this.status = {
                state: "failed",
                startedAt: this.status.startedAt,
                completedAt: new Date().toISOString(),
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
    updateProgress(message) {
        if (this.status.state === "running") {
            this.status.progress = message;
            console.log(`[librarian] ${message}`);
        }
    }
}
// ─── Singleton for harness ─────────────────────────────────────────────────
let sweepManager = null;
export function getSweepManager() {
    return sweepManager;
}
export function initSweepManager(config) {
    sweepManager = new SweepManager(config);
    return sweepManager;
}
//# sourceMappingURL=sweep-worker.js.map