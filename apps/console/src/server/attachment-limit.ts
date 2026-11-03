/**
 * The largest attachment (raw bytes; the upload body is the file itself, no base64) the console can carry to a wolf.
 * Local mode (no WOLFPACK_HUB_URL): the protocol's attachment cap. Relay mode (the console talks to a hub that tunnels
 * to the wolf): the hub refuses request bodies over LINK_RELAY_MAX_BODY, so the budget is 90% of that (headroom for
 * the body-size rounding of proxies in front of the hub).
 */
import { ATTACHMENT_MAX_BYTES } from "@wolfpack/protocol/attachments";
import { LINK_RELAY_MAX_BODY } from "@wolfpack/protocol";

export interface AttachmentLimit {
	mode: "local" | "relay";
	maxBytes: number;
}

export function attachmentLimit(env: Record<string, string | undefined> = process.env): AttachmentLimit {
	const relay = !!env.WOLFPACK_HUB_URL?.trim();
	return relay ? { mode: "relay", maxBytes: Math.floor(LINK_RELAY_MAX_BODY * 0.9) } : { mode: "local", maxBytes: ATTACHMENT_MAX_BYTES };
}
