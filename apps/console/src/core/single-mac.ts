/**
 * Single-Mac mode (work-wolfpack-TdmbaV4): the desktop app runs the whole pack on one Mac and sets WOLFPACK_SINGLE_MAC=1 for its console.
 * Everything that only makes sense for a multi-machine pack is hidden: its routes answer 404 (API) or go home (pages), and the UI drops
 * its entries. With the flag unset nothing here has any effect. This file is the one place that knows the list.
 */
export const isSingleMac = (env: Record<string, string | undefined> = process.env): boolean => env.WOLFPACK_SINGLE_MAC === "1";

/** Path prefixes (page or API) of hidden features. Matches the prefix itself and anything below it, never a longer sibling name. */
export const SINGLE_MAC_HIDDEN_PREFIXES = [
	"/pair", // pairing a browser or phone to a hub
	"/api/devices", // paired devices
	"/api/hub-url", // the hub's public address for pairing
	"/api/health", // pack health, other hosts, restart / rollback / update channel
	"/api/updates", // pack component update notices
	"/api/pack", // pack domains
	"/api/stt", // voice dictation token (Deepgram)
] as const;

export function isHiddenInSingleMac(pathname: string): boolean {
	return SINGLE_MAC_HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
