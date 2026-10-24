import type { MermaidErrorComponentProps } from "streamdown";
/**
 * Fallback for mermaid diagrams that fail to parse — wired via Streamdown's
 * `mermaid.errorComponent`. Replaces the default light-themed red box with a
 * card matching the app: the error, the source in a details block (so a
 * broken diagram doesn't flood the transcript), and a retry.
 */
export declare const MermaidError: ({ chart, error, retry, className, }: MermaidErrorComponentProps & {
    className?: string;
}) => any;
//# sourceMappingURL=mermaid-error.d.ts.map