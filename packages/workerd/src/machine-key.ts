/**
 * The machine key (work-wolfpack-6EmU8pu): an X25519 keypair at `<dir>/machine-key.pem` (PKCS8 PEM, mode 0600), created on first start.
 * Its public half goes in the hello `pubkey`; the hub fingerprints it and flags a change. Browsers seal keys to it (see @wolfpack/protocol seal).
 * Known limit (accepted): the hub relays the public key, so a compromised hub could swap it. No defence is built against that.
 * A corrupt or unreadable file is an error: replacing it would silently change the machine's identity.
 */
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { join } from "node:path";
import { b64uEncode, generateMachineKeyPair } from "@wolfpack/protocol";

export interface MachineKey {
  /** Raw X25519 public key, base64url. */
  publicKey: string;
  privateKeyPkcs8: Uint8Array;
}

export const machineKeyFile = (dir: string): string => join(dir, "machine-key.pem");

function parse(file: string): MachineKey {
  const priv = createPrivateKey(readFileSync(file, "utf8"));
  if (priv.asymmetricKeyType !== "x25519") throw new Error("machine-key.pem is not an X25519 key");
  const spki = createPublicKey(priv).export({ type: "spki", format: "der" });
  return { publicKey: b64uEncode(new Uint8Array(spki.subarray(spki.length - 32))), privateKeyPkcs8: new Uint8Array(priv.export({ type: "pkcs8", format: "der" })) };
}

export async function loadOrCreateMachineKey(dir: string): Promise<MachineKey> {
  const file = machineKeyFile(dir);
  if (existsSync(file)) {
    chmodSync(file, 0o600);
    return parse(file);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const k = await generateMachineKeyPair();
  const pem = createPrivateKey({ key: Buffer.from(k.privateKeyPkcs8), format: "der", type: "pkcs8" }).export({ type: "pkcs8", format: "pem" }) as string;
  // Private temp file hard-linked into place: a reader never sees a partial file, and a racing creator loses with EEXIST and reads the winner's.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, pem, { mode: 0o600 });
  try {
    linkSync(tmp, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
  return parse(file);
}
