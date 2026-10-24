import type { Usage } from "@earendil-works/pi-ai";
import type { SearchProvider } from "../../core/search.ts";
import type { PiEngine } from "../models.ts";
export interface ResearcherRunOptions {
    engine?: PiEngine;
    /** The search seam (search port wave, 2026-09-20): resolves the LIVE
     *  provider per call, null = honestly unavailable (the web_search tool
     *  reports that in its output — no crash, no silent fallback). Absent
     *  seam reads as unavailable: the server wiring always injects one; the
     *  dispatch-level drop (jobTools) keeps doomed jobs from even starting. */
    search?: () => SearchProvider | null;
    /** The researcher's PDF dir (PDF wave, 2026-10-07): when present, the
     *  toolset gains web_fetch_pdf + pdf_info/pdf_extract/pdf_search scoped
     *  to this per-job temp dir — PDFs from the web, read page-level. The
     *  runner owns its lifecycle (mkdtemp before, rm after). */
    pdfDir?: string;
    abortSignal?: AbortSignal;
    onUsage?: (usage: Usage) => void;
    onToolStart?: (toolName: string, args: unknown) => void;
    /** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
    chatId?: string;
}
/**
 * Run the researcher to completion: isolated context, web tools only, final
 * text = the brief. The engine and search seam are injectable so tests run
 * the loop scripted.
 */
export declare function runResearcherAgent(prompt: string, opts?: ResearcherRunOptions): Promise<string>;
export type ResearcherAgent = ReturnType<typeof runResearcherAgent>;
//# sourceMappingURL=researcher.d.ts.map