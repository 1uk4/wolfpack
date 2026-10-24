/**
 * Shared plumbing for the learner-filesystem tools (ls / find / grep) —
 * sources v1 (2026-09-19): the agent locates and reads the learner's files
 * itself, so paths need no UI affordance (user decision: no attachments —
 * the learner references files in messages; the agent finds them).
 *
 * Safety posture (user-locked): READ-ONLY by construction — no shell-out,
 * no user-controlled process args, no mutation APIs anywhere here. The one
 * deliberate scope widening vs pi: relative paths and default roots resolve
 * against the LEARNER'S HOME, not a project cwd — the harness has no
 * meaningful working directory, and "find my notes" should just work.
 *
 * Ported behaviors (mirroring pi's dist/core/tools/{ls,find,grep}.js): the
 * schemas, descriptions, output formats, and truncation notices are copied
 * verbatim except where semantics differ (home default, no .gitignore —
 * replaced by hard noise exclusions).
 */
/** 50KB — pi's DEFAULT_MAX_BYTES, the output ceiling for every fs tool. */
export declare const MAX_OUTPUT_BYTES: number;
/** pi's grep line-truncation length (GREP_MAX_LINE_LENGTH). */
export declare const GREP_MAX_LINE_LENGTH = 500;
/** Wall-clock budget for tree walks (find/grep over a whole home dir). */
export declare const WALK_TIMEOUT_MS = 10000;
/** Resolve a tool path argument: absolute stays, relative/absent → home.
 *  (pi resolves against the project cwd; the harness's "project" is the
 *  learner's life, so the home directory is the anchor.) */
export declare function resolveSourcePath(p?: string): string;
/** pi's formatSize idiom (50KB prints as "50.0KB"). */
export declare function formatSize(bytes: number): string;
/** Cap output to MAX_OUTPUT_BYTES on whole lines, pi's truncateHead idiom. */
export declare function capOutput(lines: string[]): {
    content: string;
    truncated: boolean;
};
/** Expand top-level brace alternatives: '*.{ts,tsx}' → ['*.ts', '*.tsx'].
 *  Nested braces are out of scope (pi's fd handles them; models rarely
 *  emit them — a non-expanding literal match is the graceful fallback). */
export declare function expandBraces(pattern: string): string[];
/** Glob → anchored RegExp. '*' stays within a segment, '**' crosses '/',
 *  '?' is one char, everything else literal. */
export declare function globToRegex(glob: string): RegExp;
/**
 * pi/fd's matching rule: a pattern with no slash matches against the
 * BASENAME at any depth; one with a slash matches the relative path, with
 * an implied leading "**-slash" prefix unless it is itself anchored (see
 * the code below — the literal sequence cannot appear in this comment
 * because it terminates block comments).
 */
export declare function matchGlob(relativePath: string, pattern: string): boolean;
/**
 * Depth-first walk under `root`, never entering EXCLUDED_DIR_NAMES.
 * `visit` receives absolute file paths; returning true STOPS the walk
 * (find's result limit). The deadline bounds a home-dir walk to
 * WALK_TIMEOUT_MS — partial results are the graceful degradation.
 */
export declare function walkFiles(root: string, visit: (filePath: string) => boolean | Promise<boolean>, signal?: AbortSignal): Promise<{
    timedOut: boolean;
    aborted: boolean;
}>;
/** True if the first 8KB chunk contains a NUL byte — pi/rg's binary skip. */
export declare function isBinaryFile(filePath: string): Promise<boolean>;
/** pi's GREP_MAX_LINE_LENGTH line truncation (no mid-word care, hard cap). */
export declare function truncateGrepLine(line: string): {
    text: string;
    wasTruncated: boolean;
};
//# sourceMappingURL=fs-shared.d.ts.map