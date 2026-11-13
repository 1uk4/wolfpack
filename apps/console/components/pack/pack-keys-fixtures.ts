/**
 * DEV ONLY (work-wolfpack-6EmU8pu): fake machines and a fake send so the Keys section can be checked without a hub.
 *   ?packFixture=keys            three machines (Mac, sfo-01, a Linux box); saving works
 *   ?packFixture=keys-env-shadow  sfo-01's Anthropic key is set in the Pack and also in its environment
 *   ?packFixture=keys-rejected    every save is rejected by the provider ("invalid x-api-key"), the old key is kept
 *   ?packFixture=keys-timeout     every save times out (outcome unknown; a manual Retry is offered)
 *   ?packFixture=keys-subscription  the Mac runs on the Claude subscription (Chat cell muted, no restart); sfo-01 is mixed; a third box is API-only
 * Sealing is real (WebCrypto, to a throwaway machine key); only the machine end is faked. Ignored in production.
 */
import { generateMachineKeyPair, type CommandResult, type KeyMachine } from "@/src/core";

export const KEYS_FIXTURES = ["keys", "keys-env-shadow", "keys-rejected", "keys-timeout", "keys-subscription"] as const;
export type KeysFixture = (typeof KEYS_FIXTURES)[number];

export function keysFixtureFromUrl(search: string): KeysFixture | null {
	if (process.env.NODE_ENV === "production") return null;
	const f = new URLSearchParams(search).get("packFixture");
	return (KEYS_FIXTURES as readonly string[]).includes(f ?? "") ? (f as KeysFixture) : null;
}

export function fixtureKeysIo(fixture: KeysFixture) {
	let machines: Promise<KeyMachine[]> | null = null;
	const make = async (): Promise<KeyMachine[]> => {
		const pk = async () => (await generateMachineKeyPair()).publicKey;
		const shadow = fixture === "keys-env-shadow";
		if (fixture === "keys-subscription") {
			return [
				{ hostId: "luka-mac", machine: "Mac", online: true, canSetKeys: true, servesConsole: true, pubkey: await pk(), fingerprint: "a1b2c3d4e5f60718", midReply: ["hal"], wolves: [{ name: "hal", transport: "subscription" }], slots: [] },
				{ hostId: "sfo-01-wolves", machine: "sfo-01", online: true, canSetKeys: true, pubkey: await pk(), fingerprint: "0f9e8d7c6b5a4938", wolves: [{ name: "hal", transport: "subscription" }, { name: "dewey", transport: "api" }], slots: [] },
				{ hostId: "old-box", machine: "old-box", online: true, canSetKeys: true, pubkey: await pk(), fingerprint: "1122334455667788", wolves: [{ name: "scout", transport: "api" }], slots: [{ slot: "anthropic", present: true, masked: "••••9d3c", source: "pack" }] },
			] as KeyMachine[];
		}
		return [
			{ hostId: "luka-mac", machine: "Mac", online: true, canSetKeys: true, servesConsole: true, pubkey: await pk(), fingerprint: "a1b2c3d4e5f60718", midReply: ["hal"], wolves: [{ name: "hal", transport: "api" }], slots: [{ slot: "anthropic", present: true, masked: "••••4f2a", source: "pack" }] },
			{ hostId: "sfo-01-wolves", machine: "sfo-01", online: true, canSetKeys: true, servesConsole: true, pubkey: await pk(), fingerprint: "0f9e8d7c6b5a4938", slots: [{ slot: "anthropic", present: true, masked: "••••9c1e", source: "pack", shadowsEnv: shadow }, { slot: "deepgram", present: true, masked: "••••77ab", source: "env" }] },
			{ hostId: "old-box", machine: "old-box", online: true, canSetKeys: false, slots: [] },
		];
	};
	return {
		load: async () => ({ machines: await (machines ??= make()) }),
		send: async (_host: string, cmd: { kind: string }): Promise<CommandResult> => {
			await new Promise((r) => setTimeout(r, 400));
			if (cmd.kind === "key.remove") return { id: "c-fx", ok: true, data: { restarted: [] } };
			if (fixture === "keys-rejected") return { id: "c-fx", ok: false, code: "rejected_key", message: "invalid x-api-key" };
			if (fixture === "keys-timeout") return { id: "c-fx", ok: false, code: "timeout", message: "no answer in time; the outcome is unknown" };
			return { id: "c-fx", ok: true, data: { restarted: [{ wolf: "hal", wasActive: true, midReply: true }] } };
		},
	};
}
