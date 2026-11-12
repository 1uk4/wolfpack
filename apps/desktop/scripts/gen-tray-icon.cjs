// Regenerates electron/tray/trayTemplate.png (+@2x) from the wolf-head path in build/icon-flat.svg.
// Black on transparent: macOS recolours "Template" images for light/dark menu bars.
// Usage: node scripts/gen-tray-icon.cjs
const { Resvg } = require("@resvg/resvg-js");
const fs = require("node:fs");
const path = require("node:path");

const out = path.join(__dirname, "..", "electron", "tray");
fs.mkdirSync(out, { recursive: true });
const d = "M8 2L24 18H40L56 2L57 27L63 33L52 39L32 62L12 39L1 33L7 27Z M16 28L27 32L19.5 35.5Z M48 28L37 32L44.5 35.5Z";
for (const [name, px] of [["trayTemplate.png", 18], ["trayTemplate@2x.png", 36]]) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 64 64"><path fill="#000" fill-rule="evenodd" d="${d}"/></svg>`;
	fs.writeFileSync(path.join(out, name), new Resvg(svg).render().asPng());
}
