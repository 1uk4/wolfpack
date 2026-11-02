// One-off generator for the PWA icons (plain mark: a light ring with a gap on the console's #141414). No deps, no network.
// Usage: node scripts/gen-icons.mjs   (writes public/icons/*.png; the PNGs are committed)
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(OUT, { recursive: true });
const BG = [0x14, 0x14, 0x14], FG = [0xe8, 0xe8, 0xe8], GREY = [0x94, 0x94, 0x94];

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };

/** scale = ring radius as a fraction of the canvas half-size (maskable needs the mark inside the central 80%). */
function png(size, scale) {
	const raw = Buffer.alloc((size * 3 + 1) * size);
	const R = (size / 2) * scale, W = R * 0.16, SS = 3;
	for (let y = 0; y < size; y++) {
		raw[y * (size * 3 + 1)] = 0;
		for (let x = 0; x < size; x++) {
			let acc = [0, 0, 0];
			for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
				const dx = x + (sx + 0.5) / SS - size / 2, dy = y + (sy + 0.5) / SS - size / 2;
				const d = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
				const ring = Math.abs(d - R) <= W / 2;
				const gap = ang > -1.1 && ang < -0.5 && d > R * 0.55; // the harness spiral's opening
				const inner = Math.abs(d - R * 0.62) <= W / 3.2;
				const c = ring && !gap ? FG : inner ? GREY : BG;
				acc = acc.map((v, i) => v + c[i]);
			}
			const o = y * (size * 3 + 1) + 1 + x * 3;
			for (let i = 0; i < 3; i++) raw[o + i] = Math.round(acc[i] / (SS * SS));
		}
	}
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
for (const [name, size, scale] of [["icon-192.png", 192, 0.7], ["icon-512.png", 512, 0.7], ["icon-maskable-512.png", 512, 0.5], ["apple-touch-icon.png", 180, 0.6]]) writeFileSync(join(OUT, name), png(size, scale));
