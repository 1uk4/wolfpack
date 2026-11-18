/**
 * The per-file upload budget in relay mode, client-safe (no protocol import, which would pull zod into the browser bundle):
 * 90% of the hub's 2 MB request-body cap (LINK_RELAY_MAX_BODY; a test pins the two together).
 */
export const RELAY_ATTACHMENT_BYTES = Math.floor(2 * 1024 * 1024 * 0.9);
