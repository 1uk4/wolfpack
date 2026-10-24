/**
 * POST /api/graph/import — the format-agnostic front door's transport
 * (vision §1, 2026-09-13): raw personal-notes files in, one extraction run
 * per file through the SAME pipeline the sessions use. Multipart form data
 * (field "files", any text format — the extractor is format-agnostic); the
 * pipeline mints a deterministic source id per file path, persists the
 * source record (the file's provenance + the run's usage), and runs
 * extractor → auditor → merger over the raw text.
 *
 * Small concurrency cap: the model calls are the slow part, and a burst of
 * 25 simultaneous runs would trip provider rate limits — a 3-wide worker
 * pool keeps the run registry (the dock's status chips) and the ledgers
 * healthy. The dock's chips + graph refetch track progress live through
 * /api/graph/status, as with session runs.
 */
import { extraction, NotesImportError } from "@/src/server";
import { ModelsNotConfiguredError, PROVIDER_KEY_MISSING_CODE, ProviderKeyMissingError, } from "@/src/core";
export const dynamic = "force-dynamic";
export async function POST(request) {
    const form = await request.formData();
    const files = form.getAll("files").filter((f) => f instanceof File);
    if (files.length === 0) {
        return Response.json({ results: [], error: "no files" }, { status: 400 });
    }
    const results = [];
    const queue = files.map((file, requestIndex) => ({ file, requestIndex }));
    const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
        for (;;) {
            const next = queue.shift();
            if (!next)
                return;
            const { file, requestIndex } = next;
            try {
                const text = await file.text();
                const stats = await extraction.importNotes({ filePath: file.name, text });
                results.push({ filePath: file.name, requestIndex, outcome: "completed", ok: true, stats });
            }
            catch (err) {
                if (err instanceof ModelsNotConfiguredError) {
                    results.push({
                        filePath: file.name,
                        ok: false,
                        requestIndex, outcome: "failed",
                        error: err.envelope.error,
                        code: "models_not_configured",
                        missing: err.envelope.missing,
                    });
                    continue;
                }
                if (err instanceof ProviderKeyMissingError) {
                    results.push({
                        filePath: file.name,
                        ok: false,
                        requestIndex, outcome: "failed",
                        error: err.envelope.error,
                        code: PROVIDER_KEY_MISSING_CODE,
                        provider: err.envelope.provider,
                        slots: err.envelope.slots,
                    });
                    continue;
                }
                results.push({
                    filePath: file.name, requestIndex, ok: false,
                    outcome: err instanceof NotesImportError ? err.outcome : "failed",
                    ...(err instanceof NotesImportError ? { stats: err.partialStats } : {}),
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    });
    await Promise.all(workers);
    return Response.json({ results });
}
//# sourceMappingURL=route.js.map