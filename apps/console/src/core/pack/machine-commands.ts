/**
 * The browser's client for the hub command channel (work-wolfpack-4qae7Hg), shared by the Machines and Keys sections. Generic: it knows
 * the route and the result shape, not any command. POST /api/machines/:id/commands (src/server/pack/machines-api.ts) answers the hub's
 * result with 200, 409 (not_sent_*) or 504 (timeout); those are results. Anything else (console refusal, non-JSON, no network) becomes an
 * `ok: false` result with no hub code and an empty id, so callers handle one shape. Never throws (an abort from the caller's signal rethrows the AbortError).
 *
 * `sealed` is the opaque serialised sealed payload (a sealed key for key.set; well under the console's 128 KB body limit, which answers 413).
 * `id` is an optional client-chosen command id (`c-...`, the hub's pattern): the seal binds it, so the sealer must choose it.
 * The client waits COMMAND_CLIENT_TIMEOUT_MS (30 s), longer than the hub's 20 s, so a hub 504 normally arrives first. If the client's own
 * timer fires, the result is `ok:false` with code "timeout" = outcome unknown: callers must NOT resend on their own (offer a manual Retry).
 */
export const COMMAND_CLIENT_TIMEOUT_MS = 30_000;
export interface CommandResult {
	id: string;
	ok: boolean;
	code?: string;
	message?: string;
	data?: unknown;
}

export async function sendMachineCommand(
	hostId: string,
	cmd: { kind: string; args?: unknown; sealed?: string; id?: string },
	opts: { signal?: AbortSignal } = {},
): Promise<CommandResult> {
	const timer = AbortSignal.timeout(COMMAND_CLIENT_TIMEOUT_MS);
	let res: Response;
	try {
		// Plain fetch on purpose: components/shell/hub-auth.tsx wraps window.fetch (withHubAuth) and adds the Bearer token to every same-origin /api/ request, POST included.
		res = await fetch(`/api/machines/${encodeURIComponent(hostId)}/commands`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind: cmd.kind, args: cmd.args ?? {}, ...(cmd.sealed !== undefined ? { sealed: cmd.sealed } : {}), ...(cmd.id ? { id: cmd.id } : {}) }),
			signal: opts.signal ? AbortSignal.any([opts.signal, timer]) : timer,
		});
	} catch (e) {
		// The caller's own abort rethrows; our timer firing is an unknown outcome, not a throw.
		if (opts.signal?.aborted) throw e;
		if (timer.aborted || (e as Error)?.name === "TimeoutError") return { id: "", ok: false, code: "timeout", message: "No answer in time; the outcome is unknown" };
		if ((e as Error)?.name === "AbortError") throw e;
		return { id: "", ok: false, message: "Console unreachable; command not sent" };
	}
	const body = (await res.json().catch(() => null)) as Partial<CommandResult> | null;
	if ((res.status === 200 || res.status === 409 || res.status === 504) && body && typeof body.ok === "boolean") return body as CommandResult;
	if (res.status === 401) return { id: "", ok: false, message: "Sign in with the console once while the hub is up" };
	return { id: "", ok: false, message: `Command failed (HTTP ${res.status})` };
}
