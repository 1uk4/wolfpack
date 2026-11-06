/**
 * Is the console in RELAY mode (everything goes through the hub, which tunnels to the wolf's host)? ONE decision for the
 * client factory and the attachment limit. Relay when a hub URL is set and either WOLFPACK_HUB_RELAY forces it (1/true/yes/on),
 * or no direct WOLFPACK_API_URL is set and a hub token exists (`haveToken`: the browser's per-request token or the env token).
 * WOLFPACK_HUB_RELAY=0/false/no/off never relays.
 */
export function isRelayMode(env: Record<string, string | undefined>, haveToken: boolean): boolean {
	const hubUrl = env.WOLFPACK_HUB_URL?.trim();
	if (!hubUrl) return false;
	const flag = env.WOLFPACK_HUB_RELAY?.trim() ?? "";
	if (/^(0|false|no|off)$/i.test(flag)) return false;
	if (/^(1|true|yes|on)$/i.test(flag)) return true;
	return !env.WOLFPACK_API_URL?.trim() && haveToken;
}
