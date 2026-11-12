/**
 * Browser side of sealed key delivery (work-wolfpack-6EmU8pu). Pure WebCrypto via @wolfpack/protocol; no network here.
 * A browser without X25519 in WebCrypto cannot edit keys: `sealSupport` feature-detects it and `X25519_MISSING_MESSAGE` is what to show.
 */
import { seal, supportsX25519 } from "@wolfpack/protocol/seal";
import { checkKeyShape } from "@wolfpack/protocol/providers";

export const X25519_MISSING_MESSAGE = "This browser can't seal keys (it lacks X25519 in WebCrypto), so keys can't be edited here. Use a current Chrome, Edge, Safari or Firefox.";

export async function sealSupport(): Promise<{ ok: true } | { ok: false; message: string }> {
	return (await supportsX25519()) ? { ok: true } : { ok: false, message: X25519_MISSING_MESSAGE };
}

/** A fresh command id the seal binds (the hub accepts a client-chosen one). */
export const newCommandId = (): string => `c-${globalThis.crypto.randomUUID()}`;

export { checkKeyShape };

/** Seal `key` for one machine and command. */
export function sealKeyFor(a: { pubkey: string; hostId: string; cmdId: string; slot: string; key: string; now?: number }): Promise<string> {
	return seal(a.pubkey, { hostId: a.hostId, cmdId: a.cmdId, slot: a.slot, key: a.key, issuedAt: a.now ?? Date.now() });
}
