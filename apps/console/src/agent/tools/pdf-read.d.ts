import type { AgentTool } from "@earendil-works/pi-agent-core";
/** The download + triage summary the researcher sees from web_fetch_pdf. */
export interface PdfFetchSummary {
    path: string;
    url: string;
    page_count: number;
    size_class: "short" | "medium" | "long";
    mean_text_length: number;
    flagged_pages: number[];
}
export declare function createPdfReadTools(dir: string): Record<string, AgentTool<any>>;
//# sourceMappingURL=pdf-read.d.ts.map