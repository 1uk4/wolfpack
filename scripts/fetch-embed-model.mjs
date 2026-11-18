#!/usr/bin/env node
// Downloads the nomic-embed-text v1.5 ONNX files the in-process embedder needs (WOLFPACK_EMBED_PROVIDER=onnx).
//   node scripts/fetch-embed-model.mjs <dir>
// Pinned to one Hugging Face revision; every file is verified by SHA-256 and a mismatch deletes it and exits 1.
// Files already present with the right checksum are kept. The result is <dir>/{tokenizer.json,tokenizer_config.json,model.onnx}.
// fp32 only (int8 drifts from Ollama's vectors). Model files are never committed; the app bundles them later.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, resolve } from "node:path";

const REPO = "nomic-ai/nomic-embed-text-v1.5";
const REVISION = "e9b6763023c676ca8431644204f50c2b100d9aab";
const FILES = [
  { remote: "tokenizer.json", local: "tokenizer.json", sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66" },
  { remote: "tokenizer_config.json", local: "tokenizer_config.json", sha256: "d7e0000bcc80134debd2222220427e6bf5fa20a669f40a0d0d1409cc18e0a9bc" },
  { remote: "onnx/model.onnx", local: "model.onnx", sha256: "147d5aa88c2101237358e17796cf3a227cead1ec304ec34b465bb08e9d952965" }, // 547 MB
];

const dirArg = process.argv[2];
if (!dirArg) {
  console.error("usage: node scripts/fetch-embed-model.mjs <dir>");
  process.exit(2);
}
const dir = resolve(dirArg);
mkdirSync(dir, { recursive: true });

async function sha256(path) {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

async function fetchOne(f) {
  const dest = join(dir, f.local);
  if (existsSync(dest) && (await sha256(dest)) === f.sha256) {
    console.log(`ok      ${f.local} (already present)`);
    return;
  }
  const res = await fetch(`https://huggingface.co/${REPO}/resolve/${REVISION}/${f.remote}`);
  if (!res.ok || !res.body) throw new Error(`${f.remote}: HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    const got = await sha256(tmp);
    if (got !== f.sha256) throw new Error(`${f.remote}: sha256 ${got} != pinned ${f.sha256}`);
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true }); // gone after the rename; removes a partial or mismatching download
  }
  console.log(`fetched ${f.local}`);
}

try {
  for (const f of FILES) await fetchOne(f);
} catch (err) {
  console.error(`FAILED  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
console.log(`model dir ready: ${dir}`);
