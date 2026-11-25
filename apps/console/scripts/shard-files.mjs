// Split the console test files into CI shards: sort, then deal round-robin so each shard gets a mix of directories.
// CLI: node shard-files.mjs <N/M> <file...>  prints this shard's files, one per line.
export function parseShard(spec) {
	const m = /^(\d+)\/(\d+)$/.exec(String(spec).trim());
	if (!m) throw new Error(`bad shard spec "${spec}" (want N/M, e.g. 2/3)`);
	const index = Number(m[1]);
	const total = Number(m[2]);
	if (index < 1 || total < 1 || index > total) throw new Error(`bad shard spec "${spec}": need 1 <= N <= M`);
	return { index, total };
}

export function shardFiles(files, index, total) {
	return [...files].sort().filter((_, i) => i % total === index - 1);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const [spec, ...files] = process.argv.slice(2);
	const { index, total } = parseShard(spec);
	process.stdout.write(shardFiles(files, index, total).join("\n") + "\n");
}
