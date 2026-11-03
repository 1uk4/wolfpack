/**
 * The largest attachment (raw bytes; the upload body is the file itself, no base64 or multipart) the console can carry to a wolf.
 * Local mode: the protocol's attachment cap. Relay mode (same decision as the client factory, see relay-mode.ts): the hub refuses
 * request bodies over LINK_RELAY_MAX_BODY, so the budget is 90% of that (headroom for body-size rounding in front of the hub).
 */
import { ATTACHMENT_MAX_BYTES } from "@wolfpack/protocol/attachments";
import { LINK_RELAY_MAX_BODY } from "@wolfpack/protocol";
import { isRelayMode } from "./relay-mode.ts";

export interface AttachmentLimit {
	mode: "local" | "relay";
	maxBytes: number;
}

/** The conservative budget: what relay mode allows. */
export const RELAY_ATTACHMENT_BYTES = Math.floor(LINK_RELAY_MAX_BODY * 0.9);

/** `haveToken`: the request carries a hub bearer token (or the env has one). */
export function attachmentLimit(env: Record<string, string | undefined> = process.env, haveToken = !!env.WOLFPACK_HUB_TOKEN?.trim()): AttachmentLimit {
	return isRelayMode(env, haveToken) ? { mode: "relay", maxBytes: RELAY_ATTACHMENT_BYTES } : { mode: "local", maxBytes: ATTACHMENT_MAX_BYTES };
}
