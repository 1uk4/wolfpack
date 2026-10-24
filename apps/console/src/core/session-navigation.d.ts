import type { GraphNode } from "./contracts/graph.ts";
import type { LhViewMessage } from "./view.ts";
/** Message-granular graph links (owner, 2026-10-13). Persisted provenance and
 * native IDs already carry everything needed; only the render seam is new. */
export declare function messageAnchorId(messageId: string): string;
export declare function messageIdFromHash(hash: string): string | null;
/** Old empty anchors do not mask a later real one. Ledger order, not date or
 * lexical order, selects the FIRST recorded message in this source. */
export declare function propositionSessionHref(node: Pick<GraphNode, "provenance">, chatId: string): string;
/** projectView's text-part identity is <native message ID>-t<text index>.
 * Assistant GROUP IDs cannot identify an individual extraction source. */
export declare function textPartMessageId(partId: string | undefined): string | null;
/** One DOM anchor per native teacher message, at its first non-empty prose
 * block. Empty text blocks and intervening tools/thinking do not steal it. */
export declare function firstSourceTextParts(messages: readonly LhViewMessage[]): Map<string, string>;
//# sourceMappingURL=session-navigation.d.ts.map