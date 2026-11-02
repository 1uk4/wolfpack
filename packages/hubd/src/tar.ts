/** Minimal deterministic ustar writer/reader (regular files and directories only; no dependency, no system tar). */
export interface TarEntry {
  path: string;
  type: "file" | "dir";
  data: Buffer;
}

const BLOCK = 512;

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}

function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`path cannot be stored in a ustar tar (a name part is limited to 100 bytes, the directory prefix to 155): ${path}`);
}

/** Entries are written in the given order; mtime 0, uid/gid 0, mode 0644 (files) / 0755 (dirs): same input, same bytes. */
export function writeTar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const e of entries) {
    const isDir = e.type === "dir";
    const { name, prefix } = splitName(isDir ? e.path + "/" : e.path);
    const h = Buffer.alloc(BLOCK);
    h.write(name, 0, "utf8");
    h.write(octal(isDir ? 0o755 : 0o644, 8), 100, "ascii");
    h.write(octal(0, 8), 108, "ascii");
    h.write(octal(0, 8), 116, "ascii");
    h.write(octal(isDir ? 0 : e.data.length, 12), 124, "ascii");
    h.write(octal(0, 12), 136, "ascii");
    h.write("        ", 148, "ascii");
    h.write(isDir ? "5" : "0", 156, "ascii");
    h.write("ustar\0", 257, "ascii");
    h.write("00", 263, "ascii");
    h.write(prefix, 345, "utf8");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    chunks.push(h);
    if (!isDir && e.data.length) {
      chunks.push(e.data);
      const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

const cstr = (b: Buffer) => {
  const z = b.indexOf(0);
  return b.subarray(0, z < 0 ? b.length : z).toString("utf8");
};

/** An octal header field: NUL/space padding trimmed, then digits 0-7 only (parseInt alone would accept "12abc"). */
function octalField(b: Buffer, what: string): number {
  const t = cstr(b).replace(/^[ \0]+|[ \0]+$/g, "");
  if (!/^[0-7]*$/.test(t)) throw new Error(`tar header has a malformed ${what} field`);
  const n = t === "" ? 0 : parseInt(t, 8);
  if (!Number.isSafeInteger(n)) throw new Error(`tar header has a bad ${what} field`);
  return n;
}

/** Parses a tar; throws on links, devices, extension headers, bad checksums, truncation. Paths are returned raw (the caller validates them). */
export function readTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  for (;;) {
    if (off + BLOCK > buf.length) throw new Error("tar is truncated (no end-of-archive marker)");
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) {
      // End of archive: exactly two zero blocks are required, and only zero padding may follow.
      if (off + 2 * BLOCK > buf.length || !buf.subarray(off + BLOCK, off + 2 * BLOCK).every((b) => b === 0)) throw new Error("tar is truncated (needs two zero end blocks)");
      if (!buf.subarray(off + 2 * BLOCK).every((b) => b === 0)) throw new Error("tar has non-zero data after the end-of-archive marker");
      return out;
    }
    const stored = octalField(h.subarray(148, 156), "checksum");
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (stored !== sum) throw new Error("tar header checksum mismatch");
    if (cstr(h.subarray(257, 262)) !== "ustar") throw new Error("not a ustar archive");
    const flag = String.fromCharCode(h[156]!);
    const name = cstr(h.subarray(0, 100));
    const prefix = cstr(h.subarray(345, 500));
    let path = prefix ? `${prefix}/${name}` : name;
    const size = octalField(h.subarray(124, 136), "size");
    off += BLOCK;
    if (flag === "5") {
      if (size !== 0) throw new Error(`tar directory entry ${JSON.stringify(path)} has a non-zero size`);
      path = path.replace(/\/+$/, "");
      out.push({ path, type: "dir", data: Buffer.alloc(0) });
      continue;
    }
    if (flag !== "0" && flag !== "\0") throw new Error(`tar entry ${JSON.stringify(path)} has unsupported type ${JSON.stringify(flag)} (links and special files are refused)`);
    if (off + size > buf.length) throw new Error("tar is truncated (entry data)");
    out.push({ path, type: "file", data: Buffer.from(buf.subarray(off, off + size)) });
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
}
