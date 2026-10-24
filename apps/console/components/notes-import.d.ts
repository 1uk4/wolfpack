export interface NotesImportResult {
    requestIndex: number;
    filePath: string;
    ok: boolean;
    outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
    stats?: {
        nodes: number;
        chains?: number;
        droppedChains?: number;
    };
    error?: string;
    code?: string;
    missing?: string[];
    provider?: string;
    slots?: string[];
}
/** Validate the entire response before applying any row: a malformed index
 * must never attribute another file's success to this file (same names included). */
export declare function parseNotesImportResults(body: unknown, files: readonly File[]): NotesImportResult[];
export declare function postNotesImport(files: readonly File[]): Promise<NotesImportResult[]>;
/** Only error text survives a request; selected Files stay request-local. */
export declare function useNotesImport(callbacks?: {
    onStart?: () => void;
    onFinish?: () => void;
}): {
    errors: any;
    importing: any;
    onImportFiles: (files: FileList | null) => void;
};
export declare function NotesImportErrors({ errors }: {
    errors: readonly string[];
}): any;
//# sourceMappingURL=notes-import.d.ts.map