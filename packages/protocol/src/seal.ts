/**
 * Sealed key delivery (work-wolfpack-6EmU8pu). The browser seals a key to a machine's X25519 public key; only that machine can open it.
 * WebCrypto only (no node imports), so the same code runs in the browser and in workerd.
 *
 * Format: "v1." + base64url(JSON {e, n, c}): e = ephemeral X25519 public key (raw, base64url), n = AES-GCM nonce, c = ciphertext.
 * Key: X25519 shared secret -> HKDF-SHA256 (empty salt, info SEAL_INFO) -> AES-256-GCM.
 * AAD: `v1|hostId|cmdId|slot`, so a sealed key cannot be replayed to another host, command or slot.
 * Plaintext: JSON {key, issuedAt}; the machine checks issuedAt for freshness.
 *
 * Known limit (accepted): the hub relays the machine's public key, so a compromised hub could swap it. The hub fingerprints keys and
 * flags a change, but there is no defence beyond that.
 * Never log a key or a sealed payload.
 */
const SEAL_INFO = "wolfpack-key-seal-v1";
const VERSION = "v1";
const te = new TextEncoder();
const td = new TextDecoder();

export interface SealContext {
  hostId: string;
  cmdId: string;
  slot: string;
}

export function b64uEncode(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(p);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const aad = (c: SealContext): Uint8Array => te.encode(`${VERSION}|${c.hostId}|${c.cmdId}|${c.slot}`);

/** True when this runtime's WebCrypto can do X25519 (feature-detect before offering key editing). */
export async function supportsX25519(): Promise<boolean> {
  try {
    const s = globalThis.crypto?.subtle;
    if (!s) return false;
    const k = (await s.generateKey("X25519", true, ["deriveBits"])) as CryptoKeyPair;
    await s.exportKey("raw", k.publicKey);
    return true;
  } catch {
    return false;
  }
}

/** A fresh machine keypair: public key raw base64url (43 chars), private key PKCS8 bytes. */
export async function generateMachineKeyPair(): Promise<{ publicKey: string; privateKeyPkcs8: Uint8Array }> {
  const s = globalThis.crypto.subtle;
  const k = (await s.generateKey("X25519", true, ["deriveBits"])) as CryptoKeyPair;
  return {
    publicKey: b64uEncode(new Uint8Array(await s.exportKey("raw", k.publicKey))),
    privateKeyPkcs8: new Uint8Array(await s.exportKey("pkcs8", k.privateKey)),
  };
}

/** First 16 hex chars of sha256 over the raw public key bytes. */
export async function keyFingerprint(publicKey: string): Promise<string> {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", b64uDecode(publicKey) as BufferSource));
  return Array.from(d.subarray(0, 8), (x) => x.toString(16).padStart(2, "0")).join("");
}

async function aesKey(secret: ArrayBuffer, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const s = globalThis.crypto.subtle;
  const base = await s.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return s.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode(SEAL_INFO) }, base, { name: "AES-GCM", length: 256 }, false, [usage]);
}

export async function seal(machinePublicKey: string, a: SealContext & { key: string; issuedAt: number }): Promise<string> {
  const s = globalThis.crypto.subtle;
  const machine = await s.importKey("raw", b64uDecode(machinePublicKey) as BufferSource, "X25519", false, []);
  const eph = (await s.generateKey("X25519", true, ["deriveBits"])) as CryptoKeyPair;
  const secret = await s.deriveBits({ name: "X25519", public: machine }, eph.privateKey, 256);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plain = te.encode(JSON.stringify({ key: a.key, issuedAt: a.issuedAt }));
  const ct = new Uint8Array(await s.encrypt({ name: "AES-GCM", iv, additionalData: aad(a) as BufferSource }, await aesKey(secret, "encrypt"), plain));
  const e = b64uEncode(new Uint8Array(await s.exportKey("raw", eph.publicKey)));
  return `${VERSION}.${b64uEncode(te.encode(JSON.stringify({ e, n: b64uEncode(iv), c: b64uEncode(ct) })))}`;
}

/** Opens a sealed payload. Throws on any failure (wrong machine, wrong host/command/slot, tampering, bad format). */
export async function unseal(privateKeyPkcs8: Uint8Array, sealed: string, c: SealContext): Promise<{ key: string; issuedAt: number }> {
  if (!sealed.startsWith(`${VERSION}.`)) throw new Error("unsupported seal version");
  const s = globalThis.crypto.subtle;
  const body = JSON.parse(td.decode(b64uDecode(sealed.slice(VERSION.length + 1)))) as { e?: unknown; n?: unknown; c?: unknown };
  if (typeof body.e !== "string" || typeof body.n !== "string" || typeof body.c !== "string") throw new Error("bad seal");
  const priv = await s.importKey("pkcs8", privateKeyPkcs8 as BufferSource, "X25519", false, ["deriveBits"]);
  const eph = await s.importKey("raw", b64uDecode(body.e) as BufferSource, "X25519", false, []);
  const secret = await s.deriveBits({ name: "X25519", public: eph }, priv, 256);
  const plain = await s.decrypt({ name: "AES-GCM", iv: b64uDecode(body.n) as BufferSource, additionalData: aad(c) as BufferSource }, await aesKey(secret, "decrypt"), b64uDecode(body.c) as BufferSource);
  const out = JSON.parse(td.decode(plain)) as { key?: unknown; issuedAt?: unknown };
  if (typeof out.key !== "string" || typeof out.issuedAt !== "number") throw new Error("bad seal");
  return { key: out.key, issuedAt: out.issuedAt };
}
