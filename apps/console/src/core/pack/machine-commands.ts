/**
 * The browser's client for the hub command channel (work-wolfpack-4qae7Hg), shared by the Machines and Keys sections. Generic: it knows
 * the route and the result shape, not any command. POST /api/machines/:id/commands (src/server/pack/machines-api.ts) answers the hub's
 * result with 200, 409 (not_sent_*) or 504 (timeout); those are results. Anything else (console refusal, non-JSON, no network) becomes an
 * `ok: false` result with no hub code and an empty id, so callers handle one shape. Never throws (an abort rethrows the AbortError).
 */
export interface CommandResult {
	id: string;
	ok: boolean;
	code?: string;
	message?: string;
	data?: unknown;
}

export async function sendMachineCommand(hostId: string, cmd: { kind: string; args?: unknown; sealed?: string }, opts: { signal?: AbortSignal } = {}): Promise<CommandResult> {
	let res: Response;
	try {
		// Plain fetch on purpose: components/shell/hub-auth.tsx wraps window.fetch (withHubAuth) and adds the Bearer token to every same-origin /api/ request, POST included.
		res = await fetch(`/api/machines/${encodeURIComponent(hostId)}/commands`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind: cmd.kind, args: cmd.args ?? {}, ...(cmd.sealed !== undefined ? { sealed: cmd.sealed } : {}) }),
			...(opts.signal ? { signal: opts.signal } : {}),
		});
	} catch (e) {
		if ((e as Error)?.name === "AbortError") throw e;
		return { id: "", ok: false, message: "Console unreachable; command not sent" };
	}
	const body = (await res.json().catch(() => null)) as Partial<CommandResult> | null;
	if ((res.status === 200 || res.status === 409 || res.status === 504) && body && typeof body.ok === "boolean") return body as CommandResult;
	if (res.status === 401) return { id: "", ok: false, message: "Sign in with the console once while the hub is up" };
	return { id: "", ok: false, message: `Command failed (HTTP ${res.status})` };
}
