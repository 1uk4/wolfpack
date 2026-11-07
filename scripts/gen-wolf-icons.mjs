// Regenerates every wolf-head icon from brand/wolf-head.svg. Committed outputs; rerun only when the mark or colours change:
//   node scripts/gen-wolf-icons.mjs
// Needs: @resvg/resvg-js (apps/desktop dependency) and macOS `iconutil` for the .icns (exits before writing anything without it).
// Writes: console PWA icons + app/icon.png (favicon), desktop build/icon-flat.svg, icon.png, icon.ico (via apps/desktop/scripts/make-icons.mjs),
// icon.icns, and the Icon Composer layer (build/icon.icon). The dmg background has no logo (just an arrow), so it is untouched.
// Everything is rendered into a temp dir first, then renamed into place.
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, copyFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { BG, ROOT, TARGETS, markSvg } from "./wolf-icons.mjs";

if (process.platform !== "darwin" || spawnSync("which", ["iconutil"], { stdio: "ignore" }).status !== 0) {
	console.error("gen-wolf-icons: macOS `iconutil` is required to build icon.icns; nothing was written.");
	process.exit(1);
}

const { Resvg } = createRequire(join(ROOT, "apps/desktop/package.json"))("@resvg/resvg-js");
const png = (svg, size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
const DESKTOP = "apps/desktop/build";
const ICON = { scale: 0.6, radius: 0.225 };

const tmp = mkdtempSync(join(tmpdir(), "wolf-icons-"));
try {
	const staged = []; // [relative destination, temp file]
	const stage = (rel, data) => {
		const f = join(tmp, "out", String(staged.length));
		mkdirSync(dirname(f), { recursive: true });
		writeFileSync(f, data);
		staged.push([rel, f]);
	};

	for (const t of TARGETS) stage(t.out, png(markSvg(t), t.size));

	// Desktop flat source; make-icons.mjs reads it from, and writes icon.ico + icon.png (512) into, the same dir.
	const flat = join(tmp, "flat");
	mkdirSync(flat);
	writeFileSync(join(flat, "icon-flat.svg"), markSvg({ size: 1024, ...ICON }));
	execFileSync("node", [join(ROOT, "apps/desktop/scripts/make-icons.mjs"), flat], { stdio: "inherit" });
	for (const f of ["icon-flat.svg", "icon.ico", "icon.png"]) stage(`${DESKTOP}/${f}`, readFileSync(join(flat, f)));

	// icns: 16→1024 via iconutil.
	const set = join(tmp, "icon.iconset");
	mkdirSync(set);
	for (const s of [16, 32, 128, 256, 512]) for (const r of [1, 2]) {
		writeFileSync(join(set, `icon_${s}x${s}${r === 2 ? "@2x" : ""}.png`), png(markSvg({ size: s * r, ...ICON, bg: BG }), s * r));
	}
	execFileSync("iconutil", ["-c", "icns", set, "-o", join(tmp, "icon.icns")]);
	stage(`${DESKTOP}/icon.icns`, readFileSync(join(tmp, "icon.icns")));

	// Icon Composer document: one layer (the head on transparent), over the dark fill. Icon Composer's `"key" : value` spacing, no trailing newline.
	const assets = `${DESKTOP}/icon.icon/Assets`;
	stage(`${assets}/wolfhead.svg`, markSvg({ size: 1024, scale: 0.6, bg: null, fg: "#ffffff" }));
	const rgb = [1, 3, 5].map((i) => (parseInt(BG.slice(i, i + 2), 16) / 255).toFixed(5)).join(",");
	const doc = {
		fill: { "automatic-gradient": `srgb:${rgb},1.00000` },
		groups: [{ layers: [{ "image-name": "wolfhead.svg", name: "wolfhead" }], shadow: { kind: "neutral", opacity: 0.5 }, translucency: { enabled: true, value: 0.3 } }],
		"supported-platforms": { circles: ["watchOS"], squares: "shared" },
	};
	stage(`${DESKTOP}/icon.icon/icon.json`, JSON.stringify(doc, null, 2).replace(/^(\s*"[^"]+"):/gm, "$1 :"));

	// Everything rendered: now move into place (copy beside the destination, then rename).
	for (const f of readdirSync(join(ROOT, assets))) if (/^wolfpack_.*\.svg$/.test(f)) rmSync(join(ROOT, assets, f));
	for (const [rel, f] of staged) {
		const dest = join(ROOT, rel);
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(f, `${dest}.tmp`);
		renameSync(`${dest}.tmp`, dest);
		console.log(rel);
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
