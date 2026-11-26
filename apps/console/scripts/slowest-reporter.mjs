// node:test reporter: prints the slowest test files at the end of the run. Used next to `spec` in CI (CONSOLE_TEST_TIMINGS=1).
export default async function* slowest(source) {
	const files = new Map();
	for await (const event of source) {
		if (event.type !== "test:pass" && event.type !== "test:fail") continue;
		const { file, nesting, details } = event.data;
		if (nesting !== 0 || !file) continue;
		files.set(file, (files.get(file) ?? 0) + (details?.duration_ms ?? 0));
	}
	const top = [...files].sort((a, b) => b[1] - a[1]).slice(0, 15);
	const total = [...files.values()].reduce((a, b) => a + b, 0);
	yield `\nSlowest console test files (${files.size} files, ${(total / 1000).toFixed(1)}s summed):\n`;
	for (const [file, ms] of top) yield `${(ms / 1000).toFixed(1).padStart(7)}s  ${file.replace(/^.*\/apps\/console\//, "")}\n`;
}
