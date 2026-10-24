/**
 * JobStore — the fs JSON adapter: one file per background sub-agent job in
 * data/jobs/ (contracts.ts "THE ASYNC PROTOCOL"). Keyed by toolCallId for
 * dedup: the chat-handler spawn hook never creates two jobs for the same
 * tool part. Implements core/ports.ts JobStore. Idioms: sync fs, id-guarded
 * filenames, JSON with tab indentation. Writes are small and rare (activity
 * line updates); the read-modify-write sections in the runner contain no
 * awaits, so they are atomic within the single-threaded event loop.
 */
import type { JobStore } from "../core/ports.ts";
export declare const jobStore: JobStore;
//# sourceMappingURL=jobs.d.ts.map