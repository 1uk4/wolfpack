import type { LinkWolf } from "@wolfpack/protocol";

/** The env switches that make every wolf this workerd supervises KB-readable (the env its children inherit). */
export interface KbEnv {
  WOLFPACK_HUB_KB?: string;
  KB_BASE?: string;
  KB_OPS?: string;
}

/**
 * One wolf as announced in the hub hello / wolf.add. `kbReadable` = librarian, OR wolf.yaml `memory.hubKb: true` (the wolf's declaration to the hub; wolfd itself
 * keeps reading WOLFPACK_HUB_KB from its own env), OR workerd's own env says hub-KB / KB_BASE+KB_OPS. workerd never opens a wolf's `.env` (it holds secrets).
 */
export function toLinkWolf(c: { identity: { name: string; domains: string[] }; memory?: { librarian?: boolean; hubKb?: boolean } }, env: KbEnv): LinkWolf {
  const librarian = c.memory?.librarian === true;
  const hubKbOn = /^(1|true|yes|on)$/i.test((env.WOLFPACK_HUB_KB ?? "").trim());
  const kbReadable = librarian || c.memory?.hubKb === true || hubKbOn || (!!env.KB_BASE && !!env.KB_OPS);
  return { name: c.identity.name, domains: c.identity.domains, librarian, kbReadable };
}
