import type { Usage, Tool } from "@earendil-works/pi-ai";
import { type PiEngine } from "../models.ts";
import type { PdfResult, PdfToolInput } from "../../core/contracts.ts";
import { type HeadlessApi } from "./headless.ts";
export interface PdfReaderOptions {
    engine?: PiEngine;
    abortSignal?: AbortSignal;
    onUsage?: (usage: Usage) => void;
    onActivity?: (line: string) => void;
    headless?: HeadlessApi;
    maxIterations?: number;
    /** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
    chatId?: string;
}
export interface PdfReaderInput extends PdfToolInput {
}
/** The wire declarations (pi-ai Tool, TypeBox parameters). This loop owns
 *  execution itself — pdf_info/pdf_extract run via the plain pdfInfoText/
 *  pdfExtractText bodies below, pdf_search/pdf_render dispatch inline in
 *  the loop (search hits must join the citation set; renders feed the
 *  image-in-the-loop message) — so the declarations carry no execute.
 *  dpi/context_lines/literal carry the old zod `.default()`s as schema
 *  descriptions + loop-side ??-fills (the loop reads them via numOr). */
export declare function createPdfTools(_pdfPath: string): Record<string, Tool>;
export declare function runPdfReaderAgent(input: PdfReaderInput, opts?: PdfReaderOptions): Promise<PdfResult>;
//# sourceMappingURL=pdf-reader.d.ts.map